import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	BrowserDriver,
	CaptureRange,
	DriverAction,
	DriverActionResult,
	DriverConnectionState,
	DriverDisconnectReason,
	DriverSnapshot,
	TargetInfo,
} from "../contracts/ports";
import { BrowserDriverError } from "../contracts/ports";
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

/**
 * BrowserDriver over a child `@playwright/mcp --extension` (spec/browser-tabs-toolchain-design-
 * 2026-10-18.md §4, §5.2, §6.2). The only way to reach the child is `callTool`, whose names are
 * the closed list below; `browser_evaluate` is reachable only through the fixed measuring and
 * inspection functions. MCP output files hold page text, so every call ends by emptying the output dir.
 *
 * Child flags: `--extension` (the user's Brave through Playwright MCP Bridge), `--output-dir`
 * (managed temp dir), `--no-webmcp` (page-registered tools are neither collected nor exposed).
 * Left at their defaults on purpose: `--snapshot-mode full` (action results carry the `### Page`
 * URL/title this adapter needs), `--image-responses allow` (screenshots arrive as image
 * content), `--caps` (none: core tools only), timeouts, `--blocked-origins` (documented as not
 * a security boundary; destination checks stay in the browser domain).
 */

export const ALLOWED_MCP_TOOLS = [
	"browser_tabs",
	"browser_navigate",
	"browser_navigate_back",
	"browser_snapshot",
	"browser_click",
	"browser_hover",
	"browser_type",
	"browser_select_option",
	"browser_press_key",
	"browser_wait_for",
	"browser_take_screenshot",
	"browser_evaluate",
] as const;
type ToolName = (typeof ALLOWED_MCP_TOOLS)[number];
const ALLOWED_TOOLS: ReadonlySet<string> = new Set(ALLOWED_MCP_TOOLS);

/** Fixed measuring functions. No input is ever interpolated into them. */
const MEASURE_PAGE_FUNCTION =
	"() => { const d = document.documentElement; const b = document.body; return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, scrollWidth: Math.max(d.scrollWidth, b ? b.scrollWidth : 0), scrollHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0), devicePixelRatio: window.devicePixelRatio }; }";
const MEASURE_ELEMENT_FUNCTION =
	"(element) => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height, devicePixelRatio: window.devicePixelRatio }; }";

/**
 * Fixed inspection of the element an operation would act on: what the HTML says it does (spec §5.3). The
 * function reads attributes and form membership only; no input is ever interpolated into it.
 */
const INSPECT_ELEMENT_BODY = `(el) => {
  const method = (v) => { const s = String(v || '').toLowerCase(); return s === 'get' || s === 'post' || s === 'dialog' ? s : ''; };
  const textual = ['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'];
  if (!el || el === document.body || el === document.documentElement) return { tag: 'body', inForm: false, submits: false };
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' || tag === 'button' ? String(el.type || '').toLowerCase() : '';
  const typed = type ? { type } : {};
  const form = el.form || el.closest('form');
  if (!form) return { tag, ...typed, inForm: false, submits: false };
  const own = tag === 'input' || tag === 'button' ? method(el.getAttribute('formmethod')) : '';
  const formMethod = own || method(form.method) || 'get';
  const fields = Array.from(form.elements);
  const isSubmitter = (n) => (n.tagName === 'BUTTON' && n.type === 'submit') || (n.tagName === 'INPUT' && (n.type === 'submit' || n.type === 'image'));
  const isTextField = (n) => n.tagName === 'INPUT' && textual.includes(n.type);
  let submits = false;
  if (isSubmitter(el)) submits = true;
  else if (isTextField(el)) submits = fields.some(isSubmitter) || fields.filter(isTextField).length === 1;
  return { tag, ...typed, inForm: true, formMethod, submits };
}`;
const INSPECT_TARGET_FUNCTION = INSPECT_ELEMENT_BODY;
const INSPECT_FOCUSED_FUNCTION = `() => (${INSPECT_ELEMENT_BODY})(document.activeElement)`;

/** Element refs from `[ref=eN]` (optionally frame-prefixed `f1e3`). Anything else would be a selector. */
const REF = /^(?:f\d+)?e\d+$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type McpBrowserDriverOptions = {
	extensionToken?: string;
	/** Saved Brave executable. Empty or missing: `connect` ends as `not_configured`. */
	executablePath: string | undefined;
	/** Managed temp directory for MCP output; also the child's working directory. */
	outputDir: string;
	/** Deadline for initialize + the user picking a tab in Brave. Default 120 s. */
	connectTimeoutMs?: number;
	/** Deadline for one tool call. Default 90 s (MCP's own navigation timeout is 60 s). */
	callTimeoutMs?: number;
	/** Override of the child command; tests only. Defaults to this runtime + the pinned CLI. */
	launch?: { command: string; args: string[] };
	now?: () => Date;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

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
				"--extension",
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

	/** The single door to the child. Tool names outside the closed list cannot be called. */
	const callTool = (
		name: ToolName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		readSnapshotFile = false,
	): Promise<ParsedToolResult & { snapshotText?: string }> =>
		serial(signal, async () => {
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
					if (failure.code === "browser_closed")
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
		});

	const tabsCall = async (args: Record<string, unknown>) => {
		const parsed = await callTool("browser_tabs", args);
		const tabs = parseTabList(parsed.result);
		if (!tabs) throw new BrowserDriverError("mcp_response_unrecognized", true);
		return tabs.filter((tab) => !tab.url.startsWith("chrome-extension:"));
	};

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
				return { ok: true, ...(await pageOf(parsed)) };
			} catch (error) {
				const failure = toDriverError(error);
				return {
					ok: false,
					code: failure.code,
					dispatched: failure.dispatched,
				};
			}
		},
		...createReaders(callTool),
	};
}

type CallTool = (
	name: ToolName,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<ParsedToolResult>;

/**
 * The calls that read the page without changing it: the host's fixed inspection and measuring functions
 * (the only users of `browser_evaluate`) and the screenshot.
 */
function createReaders(
	callTool: CallTool,
): Pick<
	BrowserDriver,
	"inspectTarget" | "inspectFocused" | "measure" | "screenshot"
> {
	/** Inspection only reads attributes, so whatever goes wrong never reached the page's state. */
	const inspectCall = async (args: Record<string, unknown>) => {
		try {
			return (await callTool("browser_evaluate", args)).result;
		} catch (error) {
			throw new BrowserDriverError(toDriverError(error).code, false);
		}
	};
	return {
		async inspectTarget(ref) {
			return inspected(
				await inspectCall({
					function: INSPECT_TARGET_FUNCTION,
					target: refOf(ref),
					element: "inspected element",
				}),
			);
		},
		inspectFocused: async () =>
			inspected(await inspectCall({ function: INSPECT_FOCUSED_FUNCTION })),
		async measure(range, elementRef) {
			const args =
				range === "element"
					? {
							function: MEASURE_ELEMENT_FUNCTION,
							target: refOf(elementRef),
							element: "measured element",
						}
					: { function: MEASURE_PAGE_FUNCTION };
			const parsed = await callTool("browser_evaluate", args);
			return measured(range, parsed.result);
		},
		async screenshot(range, elementRef, signal) {
			const args: Record<string, unknown> = { type: "png", scale: "css" };
			if (range === "full-page") args.fullPage = true;
			if (range === "element") {
				args.target = refOf(elementRef);
				args.element = "captured element";
			}
			const parsed = await callTool("browser_take_screenshot", args, signal);
			const image = parsed.images.find((item) => item.mimeType === "image/png");
			if (!image) throw new BrowserDriverError("screenshot_missing", true);
			const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
			if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte))
				throw new BrowserDriverError("screenshot_invalid", true);
			return bytes;
		},
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

function toDriverError(error: unknown): BrowserDriverError {
	return error instanceof BrowserDriverError
		? error
		: new BrowserDriverError("mcp_unavailable", true);
}

function refOf(ref: string | undefined): string {
	if (ref === undefined || !REF.test(ref))
		throw new BrowserDriverError("invalid_ref", false);
	return ref;
}

function tabIndex(index: number): number {
	if (!Number.isInteger(index) || index < 0)
		throw new BrowserDriverError("invalid_tab_index", false);
	return index;
}

/** Defence in depth: the domain decides destinations; the adapter never sends other schemes. */
function webUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BrowserDriverError("invalid_url", false);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		throw new BrowserDriverError("invalid_url", false);
	return url;
}

function actionCall(action: DriverAction): [ToolName, Record<string, unknown>] {
	switch (action.kind) {
		case "navigate":
			return ["browser_navigate", { url: webUrl(action.url) }];
		case "back":
			return ["browser_navigate_back", {}];
		case "click":
			return [
				"browser_click",
				{ target: refOf(action.ref), element: action.element },
			];
		case "hover":
			return [
				"browser_hover",
				{ target: refOf(action.ref), element: action.element },
			];
		case "type":
			return [
				"browser_type",
				{
					target: refOf(action.ref),
					element: action.element,
					text: action.text,
					submit: action.submit,
				},
			];
		case "select":
			return [
				"browser_select_option",
				{
					target: refOf(action.ref),
					element: action.element,
					values: action.values,
				},
			];
		case "press":
			return ["browser_press_key", { key: action.key }];
		case "wait": {
			const args: Record<string, unknown> = {};
			if (action.text !== undefined) args.text = action.text;
			if (action.textGone !== undefined) args.textGone = action.textGone;
			if (action.seconds !== undefined) {
				if (!Number.isFinite(action.seconds) || action.seconds < 0)
					throw new BrowserDriverError("invalid_wait", false);
				args.time = action.seconds;
			}
			if (Object.keys(args).length === 0)
				throw new BrowserDriverError("invalid_wait", false);
			return ["browser_wait_for", args];
		}
		default:
			throw new BrowserDriverError("action_not_supported", false);
	}
}

function positive(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		throw new BrowserDriverError("measure_invalid", false);
	return Math.ceil(value);
}

/** The JSON object an evaluate call returned (MCP wraps it in a fence). */
function evaluated(result: string | undefined, code: string) {
	let value: unknown;
	try {
		value = JSON.parse(
			(result ?? "").replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""),
		);
	} catch {
		throw new BrowserDriverError(code, false);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new BrowserDriverError(code, false);
	return value as Record<string, unknown>;
}

function inspected(result: string | undefined): TargetInfo {
	const value = evaluated(result, "inspect_invalid");
	const { tag, type, inForm, formMethod, submits } = value;
	if (
		typeof tag !== "string" ||
		tag.length > 40 ||
		typeof inForm !== "boolean" ||
		typeof submits !== "boolean" ||
		(type !== undefined && (typeof type !== "string" || type.length > 40)) ||
		(formMethod !== undefined &&
			(typeof formMethod !== "string" || formMethod.length > 20))
	)
		throw new BrowserDriverError("inspect_invalid", false);
	return {
		tag,
		...(type !== undefined ? { type } : {}),
		inForm,
		...(formMethod !== undefined ? { formMethod } : {}),
		submits,
	};
}

function measured(range: CaptureRange, result: string | undefined) {
	const value = evaluated(result, "measure_invalid");
	const dpr = value.devicePixelRatio;
	const devicePixelRatio =
		typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	if (range === "element")
		return {
			width: positive(value.width),
			height: positive(value.height),
			devicePixelRatio,
		};
	if (range === "viewport")
		return {
			width: positive(value.viewportWidth),
			height: positive(value.viewportHeight),
			devicePixelRatio,
		};
	return {
		width: Math.max(positive(value.scrollWidth), positive(value.viewportWidth)),
		height: Math.max(
			positive(value.scrollHeight),
			positive(value.viewportHeight),
		),
		devicePixelRatio,
	};
}
