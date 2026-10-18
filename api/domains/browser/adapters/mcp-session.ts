import { spawn, type ChildProcess } from "node:child_process";

/**
 * Newline-delimited JSON-RPC 2.0 over the stdio of one child process (MCP stdio transport).
 * Knows nothing about tools. Never logs or retains message bodies beyond the pending call.
 */

export type McpFailureReason =
	| "timeout"
	| "aborted"
	| "exited"
	| "rpc_error"
	| "output_limit";

export class McpTransportError extends Error {
	constructor(
		readonly reason: McpFailureReason,
		/** The request line was written to the child, so the server may have acted on it. */
		readonly dispatched: boolean,
		readonly rpcCode?: number,
	) {
		super(`mcp_${reason}`);
		this.name = "McpTransportError";
	}
}

export type McpRequestOptions = { signal?: AbortSignal; timeoutMs: number };

export interface McpSession {
	request(
		method: string,
		params: unknown,
		options: McpRequestOptions,
	): Promise<unknown>;
	notify(method: string, params?: unknown): void;
	/** Called once when the child has exited, whatever the cause. */
	onExit(listener: () => void): void;
	exited(): boolean;
	/** SIGTERM, then SIGKILL after the grace period; resolves when the child is gone. */
	close(): Promise<void>;
}

export type McpSessionLaunch = {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
};

/** A screenshot arrives as one base64 line; 2,500 x 2,500 px fits far below this. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 3000;

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: McpTransportError) => void;
	dispatched: boolean;
	cleanup: () => void;
};

export function startMcpSession(launch: McpSessionLaunch): McpSession {
	const child: ChildProcess = spawn(launch.command, launch.args, {
		cwd: launch.cwd,
		env: launch.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const pending = new Map<number, Pending>();
	const exitListeners: (() => void)[] = [];
	let nextId = 0;
	let hasExited = false;
	let buffered = Buffer.alloc(0);

	const failAll = (reason: McpFailureReason) => {
		for (const [id, entry] of pending) {
			pending.delete(id);
			entry.cleanup();
			entry.reject(new McpTransportError(reason, entry.dispatched));
		}
	};
	const write = (message: object): boolean => {
		if (hasExited || !child.stdin?.writable) return false;
		child.stdin.write(`${JSON.stringify(message)}\n`);
		return true;
	};
	const handleLine = (line: string) => {
		let message: {
			id?: unknown;
			method?: unknown;
			result?: unknown;
			error?: { code?: unknown };
		};
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message.method === "string" && message.id !== undefined) {
			// Server-initiated request: answer minimally so the server never waits on us.
			write(
				message.method === "ping"
					? { jsonrpc: "2.0", id: message.id, result: {} }
					: {
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32601, message: "unsupported" },
						},
			);
			return;
		}
		if (typeof message.id !== "number") return;
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		entry.cleanup();
		if (message.error)
			entry.reject(
				new McpTransportError(
					"rpc_error",
					true,
					typeof message.error.code === "number"
						? message.error.code
						: undefined,
				),
			);
		else entry.resolve(message.result);
	};

	child.stdout?.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		let newline = buffered.indexOf(10);
		while (newline !== -1) {
			const line = buffered.subarray(0, newline).toString("utf8");
			buffered = buffered.subarray(newline + 1);
			if (line.trim()) handleLine(line);
			newline = buffered.indexOf(10);
		}
		if (buffered.length > MAX_LINE_BYTES) {
			buffered = Buffer.alloc(0);
			failAll("output_limit");
			child.kill("SIGKILL");
		}
	});
	// stderr carries page-derived text on failures; drain it without keeping any of it.
	child.stderr?.on("data", () => {});
	child.stdin?.on("error", () => {});
	child.on("error", () => {
		// spawn failure: no 'exit' follows in every runtime, so settle here too.
		onGone();
	});
	child.on("exit", () => onGone());

	function onGone() {
		if (hasExited) return;
		hasExited = true;
		failAll("exited");
		for (const listener of exitListeners) listener();
	}

	return {
		request(method, params, options) {
			return new Promise<unknown>((resolve, reject) => {
				if (options.signal?.aborted) {
					reject(new McpTransportError("aborted", false));
					return;
				}
				const id = ++nextId;
				const timer = setTimeout(() => settle("timeout"), options.timeoutMs);
				const onAbort = () => {
					write({
						jsonrpc: "2.0",
						method: "notifications/cancelled",
						params: { requestId: id, reason: "cancelled" },
					});
					settle("aborted");
				};
				const cleanup = () => {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
				};
				const settle = (reason: McpFailureReason) => {
					const entry = pending.get(id);
					if (!entry) return;
					pending.delete(id);
					cleanup();
					entry.reject(new McpTransportError(reason, entry.dispatched));
				};
				pending.set(id, { resolve, reject, dispatched: false, cleanup });
				options.signal?.addEventListener("abort", onAbort, { once: true });
				const written = write({ jsonrpc: "2.0", id, method, params });
				const entry = pending.get(id);
				if (!written) {
					settle("exited");
					return;
				}
				if (entry) entry.dispatched = true;
			});
		},
		notify(method, params) {
			write(
				params === undefined
					? { jsonrpc: "2.0", method }
					: { jsonrpc: "2.0", method, params },
			);
		},
		onExit(listener) {
			if (hasExited) listener();
			else exitListeners.push(listener);
		},
		exited: () => hasExited,
		close() {
			if (hasExited) return Promise.resolve();
			return new Promise<void>((resolve) => {
				const kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
				exitListeners.push(() => {
					clearTimeout(kill);
					resolve();
				});
				child.kill("SIGTERM");
			});
		},
	};
}
