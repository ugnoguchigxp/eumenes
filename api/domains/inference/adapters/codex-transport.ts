import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { getLogger } from "../../../infrastructure/logger";
import { fail } from "./cloud-agent-shared";
import type { CodexHome } from "./codex-home";
import {
	disabledFeatures,
	requestHeadOverrides,
	type CodexRuntime,
} from "./codex-sdk";

const log = getLogger("inference");
/** The largest frame a turn may produce, and the most one turn may produce in all. */
const FRAME_LIMIT = 1 << 20;
const TURN_LIMIT = 4 << 20;
/** The longest a new process may take to answer `initialize`; one that does not is stopped. */
const HANDSHAKE_MS = 15_000;

/** What one thread's turn is told: its notifications, and why it can not go on. */
export type ThreadHandler = {
	notify(method: string, params: Record<string, unknown>): void;
	fail(error: Error): void;
};
export type ThreadChannel = {
	/** Starts a turn's output budget. The app-server reflects the submitted input in started/completed items; those frames are bounded by the input sent, separately from model output. */
	beginTurn(inputBytes: number): void;
	detach(): void;
};
/** One long-lived `codex app-server` (stdio JSON-RPC), shared by every thread that runs on it. */
export type CodexRpc = {
	readonly alive: boolean;
	request(
		method: string,
		params: unknown,
		received?: (result: unknown) => void,
	): Promise<unknown>;
	attach(threadId: string, handler: ThreadHandler): ThreadChannel;
};
/** What makes two calls able to share a process: the login (API key and its host) and Web search. */
export type CodexConnectionSpec = {
	credential: string | null;
	baseUrl: string;
	nativeWebSearch: boolean;
};
export type CodexProcesses = {
	connect(spec: CodexConnectionSpec, signal: AbortSignal): Promise<CodexRpc>;
	/** Stops the started processes that `keep` does not hold on to. */
	sweep(keep: (rpc: CodexRpc) => boolean): void;
	/** Stops every process and waits for them to end. */
	close(): Promise<void>;
};

type Channel = {
	handler: ThreadHandler;
	received: number;
	echoFrameLimit: number;
	echoRemaining: number;
};
type Child = {
	pid: number | undefined;
	exited: boolean;
	kill(signal: NodeJS.Signals): void;
};

/** Process groups of live app-servers, so a backend that ends takes none of them along. */
const running = new Set<Child>();
let exitHook = false;
function killOnExit() {
	if (exitHook) return;
	exitHook = true;
	process.on("exit", () => {
		for (const child of running) child.kill("SIGKILL");
	});
}

export function createCodexProcesses(options: {
	runtime: CodexRuntime;
	home: CodexHome;
	/** Called after a process ended and left the pool; `remaining` counts the processes still in it. */
	onExit(rpc: CodexRpc, remaining: number): Promise<void>;
}): CodexProcesses {
	killOnExit();
	type Pooled = {
		ready: Promise<CodexRpc>;
		/** Set once the process answered `initialize`. */
		rpc?: CodexRpc;
		stop(): Promise<void>;
	};
	const pool = new Map<string, Pooled>();
	const settling = new Set<Promise<void>>();
	return {
		async connect(spec, signal) {
			signal.throwIfAborted();
			const key = JSON.stringify([
				spec.credential,
				spec.credential ? spec.baseUrl : null,
				spec.nativeWebSearch,
			]);
			let entry = pool.get(key);
			if (!entry) {
				const started = startProcess(spec, key);
				entry = started;
				pool.set(key, started);
			}
			const aborted = Promise.withResolvers<never>();
			aborted.promise.catch(() => {});
			const abort = () => aborted.reject(signal.reason ?? fail("cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			try {
				return await Promise.race([entry.ready, aborted.promise]);
			} finally {
				signal.removeEventListener("abort", abort);
			}
		},
		sweep(keep) {
			for (const pooled of pool.values())
				if (pooled.rpc && !keep(pooled.rpc)) void pooled.stop();
		},
		async close() {
			await Promise.allSettled([...pool.values()].map((p) => p.stop()));
			await Promise.allSettled(settling);
		},
	};

	function startProcess(spec: CodexConnectionSpec, key: string) {
		// `ready` and `stop` are set below, before the entry is handed out.
		const pooled = {} as Pooled;
		// A process that ends leaves the pool only while the pool still holds it (a later one may have its key).
		const leave = () => {
			if (pool.get(key) === pooled) pool.delete(key);
		};
		const ending = Promise.withResolvers<void>();
		let stopRequested = false;
		let child: Child | undefined;
		const stop = async () => {
			stopRequested = true;
			// A call made from now on starts a process of its own rather than meet this one ending.
			leave();
			child?.kill("SIGTERM");
			if (child && !child.exited)
				setTimeout(() => child?.kill("SIGKILL"), 1000).unref();
			await ending.promise;
		};
		const ready = (async () => {
			await options.home.ready();
			if (stopRequested) throw fail("incomplete_turn");
			const spawned = spawnProcess(
				spec,
				(c) => (child = c),
				(code, signal) => {
					leave();
					log.info("inference.codex_process", {
						outcome: "exited",
						count: pool.size,
						...(code === null ? {} : { exitCode: code }),
						...(signal ? { processSignal: signal } : {}),
					});
					const done: Promise<void> = options
						.onExit(spawned.rpc, pool.size)
						.catch(() => {})
						.finally(() => {
							settling.delete(done);
							ending.resolve();
						});
					settling.add(done);
				},
			);
			await spawned.handshake;
			pooled.rpc = spawned.rpc;
			log.info("inference.codex_process", {
				outcome: "started",
				count: pool.size,
			});
			return spawned.rpc;
		})();
		const wrapped = ready.catch((error) => {
			leave();
			if (child) child.kill("SIGKILL");
			else ending.resolve();
			throw error;
		});
		wrapped.catch(() => {});
		pooled.ready = wrapped;
		pooled.stop = stop;
		return pooled;
	}

	function spawnProcess(
		spec: CodexConnectionSpec,
		hold: (child: Child) => void,
		onExit: (code: number | null, signal: string | null) => void,
	): { rpc: CodexRpc; handshake: Promise<void> } {
		const overrides = [
			...Object.keys(disabledFeatures).map((name) => `features.${name}=false`),
			"features.skip_host_skill_discovery=true",
			"project_doc_max_bytes=0",
			'history.persistence="none"',
			...requestHeadOverrides,
			spec.nativeWebSearch ? 'web_search="live"' : 'web_search="disabled"',
			...(spec.credential
				? [`openai_base_url=${JSON.stringify(spec.baseUrl)}`]
				: []),
		];
		const proc = spawn(
			options.runtime.command,
			["app-server", ...overrides.flatMap((o) => ["-c", o])],
			{
				cwd: options.home.cwd,
				env: {
					...options.runtime.env,
					CODEX_HOME: options.home.path,
					...(spec.credential ? { CODEX_API_KEY: spec.credential } : {}),
				},
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const child: Child = {
			pid: proc.pid,
			exited: false,
			kill(signal) {
				if (child.exited || !proc.pid) return;
				try {
					process.kill(-proc.pid, signal);
				} catch {
					try {
						proc.kill(signal);
					} catch {
						/* already gone */
					}
				}
			},
		};
		running.add(child);
		hold(child);
		let nextId = 1;
		const channels = new Map<string, Channel>();
		const pending = new Map<
			number,
			{
				resolve(value: unknown): void;
				reject(error: Error): void;
				received?: (value: unknown) => void;
			}
		>();
		const endAll = (error: Error) => {
			for (const p of pending.values()) p.reject(error);
			pending.clear();
			for (const channel of channels.values()) channel.handler.fail(error);
		};
		const die = (error: Error) => {
			endAll(error);
			child.kill("SIGKILL");
		};
		const send = (value: unknown) =>
			proc.stdin.write(JSON.stringify(value) + "\n");
		let ended = false;
		const end = (code: number | null, signal: string | null) => {
			if (ended) return;
			ended = true;
			child.exited = true;
			running.delete(child);
			lines.close();
			endAll(fail("incomplete_turn"));
			onExit(code, signal);
		};
		proc.on("error", () => {
			die(fail("codex_unavailable"));
			// A process that never started has no exit to wait for.
			if (!proc.pid) end(null, null);
		});
		proc.stdin.on("error", () => die(fail("incomplete_turn")));
		proc.stderr.resume();
		proc.on("exit", end);
		const request = (
			method: string,
			params: unknown,
			onResult?: (value: unknown) => void,
		) => {
			if (child.exited) return Promise.reject(fail("incomplete_turn"));
			const id = nextId++;
			const result = new Promise<unknown>((resolve, reject) =>
				pending.set(id, { resolve, reject, received: onResult }),
			);
			send({ id, method, params });
			return result;
		};
		const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
		lines.on("line", (line) => {
			const bytes = Buffer.byteLength(line);
			let echoCap = 0;
			for (const c of channels.values())
				echoCap = Math.max(echoCap, c.echoFrameLimit);
			// Nothing a turn may legitimately produce is this large: the stream itself is not trusted any more.
			if (bytes > Math.max(TURN_LIMIT, echoCap)) {
				die(fail("output_limit"));
				return;
			}
			let value: Record<string, unknown>;
			try {
				value = JSON.parse(line);
			} catch {
				if (bytes > FRAME_LIMIT) die(fail("output_limit"));
				return;
			}
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				die(fail("codex_turn_failed"));
				return;
			}
			const event = value.params as
				{ threadId?: unknown; item?: { type?: unknown } } | undefined;
			const channel =
				typeof event?.threadId === "string"
					? channels.get(event.threadId)
					: undefined;
			const notification = typeof value.method === "string" && !("id" in value);
			if (channel && notification) {
				if (
					(value.method === "item/started" ||
						value.method === "item/completed") &&
					event?.item?.type === "userMessage"
				) {
					channel.echoRemaining -= bytes;
					if (bytes > channel.echoFrameLimit || channel.echoRemaining < 0)
						channel.handler.fail(fail("output_limit"));
					return;
				}
				channel.received += bytes;
				if (bytes > FRAME_LIMIT || channel.received > TURN_LIMIT) {
					channel.handler.fail(fail("output_limit"));
					return;
				}
			} else if (bytes > FRAME_LIMIT) {
				die(fail("output_limit"));
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
				} else if (notification)
					channel?.handler.notify(
						value.method as string,
						(value.params ?? {}) as Record<string, unknown>,
					);
			} catch (error) {
				const failure =
					error instanceof Error ? error : fail("codex_turn_failed");
				if (channel) channel.handler.fail(failure);
				else die(failure);
			}
		});
		const rpc: CodexRpc = {
			get alive() {
				return !child.exited;
			},
			request,
			attach(threadId, handler) {
				const channel: Channel = {
					handler,
					received: 0,
					echoFrameLimit: 0,
					echoRemaining: 0,
				};
				channels.set(threadId, channel);
				return {
					beginTurn(inputBytes) {
						channel.received = 0;
						channel.echoFrameLimit = inputBytes + 4096;
						channel.echoRemaining = 2 * channel.echoFrameLimit;
					},
					detach() {
						if (channels.get(threadId) === channel) channels.delete(threadId);
					},
				};
			},
		};
		const handshake = (async () => {
			const late = setTimeout(
				() => die(fail("codex_unavailable")),
				HANDSHAKE_MS,
			);
			late.unref?.();
			try {
				await request("initialize", {
					clientInfo: { name: "eumenes", title: "Eumenes", version: "1" },
					capabilities: null,
				});
			} catch (error) {
				die(error instanceof Error ? error : fail("codex_unavailable"));
				throw error;
			} finally {
				clearTimeout(late);
			}
			send({ method: "initialized" });
		})();
		handshake.catch(() => {});
		return { rpc, handshake };
	}
}
