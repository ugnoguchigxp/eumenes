import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { disabledFeatures, type CodexRuntime } from "./codex-sdk";

/** The same isolated, bounded stdio transport for model discovery and a model turn. */
export async function withCodexTransport<T>(
	runtime: CodexRuntime,
	cwd: string,
	signal: AbortSignal,
	fail: (reason: string) => Error,
	work: (rpc: {
		request(
			method: string,
			params: unknown,
			received?: (result: unknown) => void,
		): Promise<unknown>;
		onNotification(
			receive: (method: string, params: Record<string, unknown>) => void,
		): void;
	}) => Promise<T>,
	nativeWebSearch?: true,
) {
	signal.throwIfAborted();
	const overrides = [
		...Object.keys(disabledFeatures).map((name) => `features.${name}=false`),
		"features.skip_host_skill_discovery=true",
		"project_doc_max_bytes=0",
		'history.persistence="none"',
		"mcp_servers={}",
		nativeWebSearch ? 'web_search="live"' : 'web_search="disabled"',
	];
	const child = spawn(
		runtime.command,
		[
			"app-server",
			...overrides.flatMap((o) => ["-c", o]),
			...(runtime.extraArgs ?? []),
		],
		{
			cwd,
			env: runtime.env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let exited = false;
	let nextId = 1;
	let received = 0;
	let echoFrameLimit = 0;
	let echoRemaining = 0;
	let echoThread: unknown;
	let notify: (
		method: string,
		params: Record<string, unknown>,
	) => void = () => {};
	const failure = Promise.withResolvers<never>();
	failure.promise.catch(() => {});
	const pending = new Map<
		number,
		{
			resolve(value: unknown): void;
			reject(error: Error): void;
			received?: (value: unknown) => void;
		}
	>();
	const reject = (error: Error) => {
		for (const p of pending.values()) p.reject(error);
		pending.clear();
		failure.reject(error);
	};
	const kill = (s: NodeJS.Signals) => {
		if (exited || !child.pid) return;
		try {
			process.kill(-child.pid, s);
		} catch {
			try {
				child.kill(s);
			} catch {
				/* already gone */
			}
		}
	};
	child.on("error", () => reject(fail("codex_unavailable")));
	child.stdin.on("error", () => reject(fail("incomplete_turn")));
	child.stderr.resume();
	child.on("exit", () => {
		exited = true;
		reject(fail("incomplete_turn"));
	});
	const send = (value: unknown) =>
		child.stdin.write(JSON.stringify(value) + "\n");
	const request = (
		method: string,
		params: unknown,
		onResult?: (value: unknown) => void,
	) => {
		signal.throwIfAborted();
		if (method === "turn/start") {
			// App-server reflects the submitted user message in started/completed items.
			// Bound those frames by the input we sent, separately from model output.
			echoFrameLimit = Buffer.byteLength(JSON.stringify(params)) + 4096;
			echoRemaining = 2 * echoFrameLimit;
			echoThread = (params as { threadId?: unknown }).threadId;
		}
		const id = nextId++;
		const result = new Promise<unknown>((resolve, reject) =>
			pending.set(id, { resolve, reject, received: onResult }),
		);
		send({ id, method, params });
		return result;
	};
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	lines.on("line", (line) => {
		const bytes = Buffer.byteLength(line);
		if (bytes > Math.max(1 << 20, echoFrameLimit)) {
			reject(fail("output_limit"));
			return;
		}
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line);
		} catch {
			received += bytes;
			if (bytes > 1 << 20 || received > 4 << 20) reject(fail("output_limit"));
			return;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			reject(fail("codex_turn_failed"));
			return;
		}
		const event = value.params as
			{ threadId?: unknown; item?: { type?: unknown } } | undefined;
		if (
			(value.method === "item/started" || value.method === "item/completed") &&
			event?.threadId === echoThread &&
			event?.item?.type === "userMessage"
		) {
			echoRemaining -= bytes;
			if (bytes > echoFrameLimit || echoRemaining < 0)
				reject(fail("output_limit"));
			return;
		}
		received += bytes;
		if (bytes > 1 << 20 || received > 4 << 20) {
			reject(fail("output_limit"));
			return;
		}
		try {
			if (typeof value.id === "number" && !("method" in value)) {
				const p = pending.get(value.id);
				if (!p) return;
				pending.delete(value.id);
				if (value.error) p.reject(fail("codex_turn_failed"));
				else {
					p.received?.(value.result);
					p.resolve(value.result);
				}
			} else if ("id" in value) {
				send({
					id: value.id,
					error: { code: -32601, message: "unsupported by Eumenes" },
				});
			} else if (typeof value.method === "string")
				notify(value.method, (value.params ?? {}) as Record<string, unknown>);
		} catch (error) {
			reject(error instanceof Error ? error : fail("codex_turn_failed"));
		}
	});
	const abort = () => reject(signal.reason ?? fail("cancelled"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([
			failure.promise,
			(async () => {
				await request("initialize", {
					clientInfo: { name: "eumenes", title: "Eumenes", version: "1" },
					capabilities: null,
				});
				send({ method: "initialized" });
				return work({
					request,
					onNotification: (receive) => {
						notify = receive;
					},
				});
			})(),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
		lines.close();
		reject(fail("incomplete_turn"));
		child.stdin.end();
		kill("SIGTERM");
		setTimeout(() => kill("SIGKILL"), 1000).unref();
	}
}
