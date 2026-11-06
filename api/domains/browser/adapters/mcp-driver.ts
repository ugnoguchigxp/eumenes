import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	BrowserDriver,
	DriverActionResult,
	DriverConnectionState,
	DriverDisconnectReason,
	DriverSnapshot,
} from "../contracts/ports";
import { BrowserDriverError } from "../contracts/ports";
import {
	actionCall,
	ALLOWED_MCP_TOOLS,
	createReaders,
	createReplayRunner,
	tabIndex,
	tabsVia,
	toDriverError,
	webUrl,
	type ToolName,
} from "./mcp-driver-tools";
import { prepareMcpIsolation } from "./mcp-isolation";
import {
	classifyToolError,
	parseTabList,
	parseToolResult,
	type McpToolResult,
	type ParsedToolResult,
} from "./mcp-response";
import {
	McpTransportError,
	startMcpSession,
	type McpSession,
	type McpSessionLaunch,
} from "./mcp-session";
const ALLOWED_TOOLS: ReadonlySet<string> = new Set(ALLOWED_MCP_TOOLS);

/**
 * BrowserDriver over a child `@playwright/mcp --extension` (spec/browser-tabs-toolchain-design-
 * 2026-10-18.md §4, §5.2, §6.2). The only way to reach the child is `callTool`, whose names are
 * the closed list below; `browser_evaluate` is reachable only through the fixed measuring and
 * inspection functions, and `browser_run_code_unsafe` (arbitrary code in the server process, RCE-equivalent)
 * only through `runReplay`, which the domain calls with code its own check has passed (spec browser-history-
 * replay §3). The response of that call is never read, kept or logged. The tool ignores cancellation, so an
 * aborted replay closes its tab and, failing that, ends the child (see `runReplay`). MCP output files hold page text, so every call ends by emptying the output dir.
 *
 * Child flags: `--extension` (the user's Brave through Playwright MCP Bridge), `--output-dir`
 * (managed temp dir), `--no-webmcp` (page-registered tools are neither collected nor exposed).
 * Left at their defaults on purpose: `--snapshot-mode full` (action results carry the `### Page`
 * URL/title this adapter needs), `--image-responses allow` (screenshots arrive as image
 * content), `--caps` (none: core tools only), timeouts, `--blocked-origins` (documented as not
 * a security boundary; destination checks stay in the browser domain).
 */

export type McpBrowserDriverOptions = {
	/** Dedicated in-memory browser; never attaches to the user's extension session. */
	isolated?: boolean;
	extensionToken?: string;
	/** Saved Brave executable. Empty or missing: `connect` ends as `not_configured`. */
	executablePath: string | undefined;
	/** Managed temp directory for MCP output; also the child's working directory. */
	outputDir: string;
	/** Deadline for initialize + the user picking a tab in Brave. Default 120 s. */
	connectTimeoutMs?: number;
	/** Deadline for one tool call. Default 90 s (MCP's own navigation timeout is 60 s). */
	callTimeoutMs?: number;
	/** How long a cancelled replay may take to stop after its tab is closed before the child is ended. Default 10 s. */
	stopGraceMs?: number;
	/** Override of the child command; tests only. Defaults to this runtime + the pinned CLI. */
	launch?: { command: string; args: string[] };
	now?: () => Date;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;
const DEFAULT_CALL_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_GRACE_MS = 10_000;

/** This runtime + the pinned CLI inside node_modules; never `npx`. */
export function pinnedCliLaunch() {
	const require = createRequire(import.meta.url);
	const cli = join(
		dirname(require.resolve("@playwright/mcp/package.json")),
		"cli.js",
	);
	return { command: process.execPath, args: [cli] };
}

export function createMcpBrowserDriver(
	options: McpBrowserDriverOptions,
): BrowserDriver {
	const connectTimeoutMs =
		options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
	const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
	const now = options.now ?? (() => new Date());
	const listeners = new Set<(state: DriverConnectionState) => void>();
	let current: DriverConnectionState = { state: "disconnected" };
	let session: McpSession | undefined;
	let connecting: Promise<DriverConnectionState> | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	const setState = (next: DriverConnectionState) => {
		current = next;
		for (const listener of listeners) {
			try {
				listener(next);
			} catch {
				// A failing listener must not break the driver.
			}
		}
	};
	const disconnected = (reason: DriverDisconnectReason) =>
		setState({ state: "disconnected", reason });

	/** MCP writes snapshots, console logs and screenshots here; all of it is page content. */
	const clearOutput = async () => {
		try {
			for (const name of await readdir(options.outputDir))
				await rm(join(options.outputDir, name), {
					recursive: true,
					force: true,
				});
		} catch {
			// Missing directory: nothing to clear.
		}
	};

	/** Ends the child once; the first reason wins. */
	const end = async (target: McpSession, reason: DriverDisconnectReason) => {
		if (session !== target) return;
		session = undefined;
		disconnected(reason);
		await target.close();
		await clearOutput();
	};

	const start = (): McpSession => {
		const launch = options.launch ?? pinnedCliLaunch();
		const spec: McpSessionLaunch = {
			command: launch.command,
			args: [
				...launch.args,
				...(options.isolated
					? ["--config", join(options.outputDir, "isolation.json")]
					: ["--extension"]),
				"--output-dir",
				options.outputDir,
				"--no-webmcp",
			],
			cwd: options.outputDir,
			env: childEnv(options.executablePath ?? "", options.extensionToken),
		};
		return startMcpSession(spec);
	};

	const doConnect = async (
		signal: AbortSignal,
	): Promise<DriverConnectionState> => {
		await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
		await clearOutput();
		if (options.isolated)
			await prepareMcpIsolation(options.outputDir, options.executablePath);
		setState({ state: "connecting", startedAt: now().toISOString() });
		let child: McpSession;
		try {
			child = start();
		} catch {
			disconnected("mcp_unavailable");
			return current;
		}
		session = child;
		child.onExit(() => {
			void end(child, "process_exited");
		});
		const controller = new AbortController();
		let timedOut = false;
		let aborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, connectTimeoutMs);
		const onAbort = () => {
			aborted = true;
			controller.abort();
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		const request = {
			signal: controller.signal,
			timeoutMs: connectTimeoutMs,
		};
		try {
			await child.request(
				"initialize",
				{
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "eumenes", version: "1" },
				},
				request,
			);
			child.notify("notifications/initialized");
			// The first tool call opens Brave's connect page and returns once the user picked a tab.
			const raw = (await child.request(
				"tools/call",
				{ name: "browser_tabs", arguments: { action: "list" } },
				request,
			)) as McpToolResult;
			const parsed = parseToolResult(raw);
			if (parsed.isError || !parseTabList(parsed.result)) {
				await end(child, "mcp_unavailable");
				return current;
			}
			if (session !== child) return current;
			setState({ state: "connected", connectedAt: now().toISOString() });
			return current;
		} catch (error) {
			if (session === child)
				await end(
					child,
					timedOut
						? "connect_timeout"
						: aborted
							? "user"
							: error instanceof McpTransportError && error.reason === "exited"
								? "process_exited"
								: "mcp_unavailable",
				);
			return current;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			await clearOutput();
		}
	};

	const serial = <T>(
		signal: AbortSignal | undefined,
		run: () => Promise<T>,
	): Promise<T> => {
		const next = queue.then(() => {
			if (signal?.aborted) throw new BrowserDriverError("cancelled", false);
			return run();
		});
		queue = next.catch(() => {});
		return next;
	};

	/**
	 * The single door to the child. Tool names outside the closed list cannot be called. Callers hold the
	 * serial section (`callTool`), except `runReplay`, which holds it for its whole run and sends its stop
	 * requests from inside it.
	 */
	const callToolNow = (
		name: ToolName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		readSnapshotFile = false,
		/** True while the caller itself closes the page the call works on: the closed-page error is then its doing. */
		closing: () => boolean = () => false,
	): Promise<ParsedToolResult & { snapshotText?: string }> =>
		(async () => {
			if (!ALLOWED_TOOLS.has(name))
				throw new BrowserDriverError("tool_not_allowed", false);
			const child = session;
			if (!child || current.state !== "connected")
				throw new BrowserDriverError("not_connected", false);
			try {
				let raw: McpToolResult;
				try {
					raw = (await child.request(
						"tools/call",
						{ name, arguments: args },
						{ signal, timeoutMs: callTimeoutMs },
					)) as McpToolResult;
				} catch (error) {
					throw fromTransport(error);
				}
				const parsed = parseToolResult(raw);
				if (parsed.isError) {
					const failure = classifyToolError(parsed.error, name);
					if (failure.code === "browser_closed" && !closing())
						void end(child, "browser_closed");
					throw new BrowserDriverError(failure.code, failure.dispatched);
				}
				const snapshotText =
					readSnapshotFile && parsed.snapshot?.kind === "file"
						? await readOutputFile(options.outputDir, parsed.snapshot.name)
						: undefined;
				return { ...parsed, snapshotText };
			} catch (error) {
				if (
					error instanceof BrowserDriverError &&
					(error.code === "process_exited" || error.code === "mcp_unavailable")
				)
					void end(child, error.code);
				throw error;
			} finally {
				await clearOutput();
			}
		})();
	const callTool = (
		name: ToolName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		readSnapshotFile = false,
	) => serial(signal, () => callToolNow(name, args, signal, readSnapshotFile));

	const tabsCall = (args: Record<string, unknown>) => tabsVia(callTool, args);

	const runReplay = createReplayRunner({
		serial,
		call: callToolNow,
		connectedSession: () =>
			current.state === "connected" ? session : undefined,
		end,
		stopGraceMs,
	});

	const pageOf = async (parsed: ParsedToolResult) => {
		if (parsed.page) return parsed.page;
		const tab = (await tabsCall({ action: "list" })).find((t) => t.current);
		if (!tab) throw new BrowserDriverError("mcp_response_unrecognized", true);
		return { url: tab.url, title: tab.title };
	};

	return {
		connect(signal) {
			if (current.state === "connected") return Promise.resolve(current);
			if (connecting) return connecting;
			if (!options.executablePath) {
				disconnected("not_configured");
				return Promise.resolve(current);
			}
			connecting = doConnect(signal).finally(() => {
				connecting = undefined;
			});
			return connecting;
		},
		async disconnect() {
			const child = session;
			if (child) await end(child, "user");
			else if (current.state !== "disconnected") disconnected("user");
		},
		state: () => current,
		onStateChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		listTabs: () => tabsCall({ action: "list" }),
		selectTab: async (index) =>
			tabsCall({ action: "select", index: tabIndex(index) }),
		newTab: async (url) => tabsCall({ action: "new", url: webUrl(url) }),
		closeTab: async (index) =>
			tabsCall({ action: "close", index: tabIndex(index) }),
		async snapshot(signal) {
			const parsed = await callTool("browser_snapshot", {}, signal, true);
			const text =
				parsed.snapshot?.kind === "inline"
					? parsed.snapshot.text
					: parsed.snapshotText;
			if (text === undefined || !parsed.page)
				throw new BrowserDriverError("mcp_response_unrecognized", false);
			return { ...parsed.page, snapshot: text } satisfies DriverSnapshot;
		},
		async act(action, signal): Promise<DriverActionResult> {
			try {
				const [name, args] = actionCall(action);
				const parsed = await callTool(name, args, signal);
				return {
					ok: true,
					...(await pageOf(parsed)),
					...(parsed.code ? { code: parsed.code } : {}),
				};
			} catch (error) {
				const failure = toDriverError(error);
				return {
					ok: false,
					code: failure.code,
					dispatched: failure.dispatched,
				};
			}
		},
		runReplay,
		...createReaders(callTool),
	};
}

/** Only the browser path, PATH/HOME and optional Bridge token reach this child. */
function childEnv(
	executablePath: string,
	extensionToken?: string,
): Record<string, string> {
	const env: Record<string, string> = {
		PLAYWRIGHT_MCP_EXECUTABLE_PATH: executablePath,
	};
	if (extensionToken) env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = extensionToken;
	if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
	if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
	return env;
}

/** Links are relative to MCP's workspace or absolute; only the base name is looked up. */
async function readOutputFile(directory: string, name: string) {
	try {
		return await readFile(join(directory, name), "utf8");
	} catch {
		throw new BrowserDriverError("snapshot_file_missing", false);
	}
}

function fromTransport(error: unknown): BrowserDriverError {
	if (!(error instanceof McpTransportError))
		return new BrowserDriverError("mcp_unavailable", true);
	switch (error.reason) {
		case "timeout":
			return new BrowserDriverError("call_timeout", error.dispatched);
		case "aborted":
			return new BrowserDriverError("cancelled", error.dispatched);
		case "exited":
			return new BrowserDriverError("process_exited", error.dispatched);
		case "output_limit":
			return new BrowserDriverError("mcp_unavailable", true);
		case "rpc_error":
			// -32602 invalid params / -32601 unknown method: rejected before any tool ran.
			return new BrowserDriverError(
				"mcp_protocol_error",
				error.rpcCode !== -32602 && error.rpcCode !== -32601,
			);
	}
}
