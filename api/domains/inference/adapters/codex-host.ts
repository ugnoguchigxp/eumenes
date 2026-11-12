import { join, resolve } from "node:path";
import { fail } from "./cloud-agent-shared";
import {
	runCodexTurn,
	type CodexTurn,
	type CodexTurnResult,
} from "./codex-app-server";
import { createCodexHome } from "./codex-home";
import { readCodexModels } from "./codex-models";
import { codexRuntime } from "./codex-sdk";
import { createCodexThreads } from "./codex-threads";
import { createCodexProcesses } from "./codex-transport";
import type { ConnectionModels } from "../contracts";

/** The login a call runs under: an API key with its host, or (null) the CLI's own login. */
export type CodexLogin = { credential: string | null; baseUrl: string };
export type CodexHost = {
	run(login: CodexLogin, turn: CodexTurn): Promise<CodexTurnResult>;
	/** No thread or model turn is created while reading the selected account's catalog. */
	models(
		login: CodexLogin,
		signal: AbortSignal,
	): Promise<ConnectionModels["models"]>;
	/**
	 * Something was forgotten: every thread goes, and once the calls under way have ended the processes stop and
	 * the home is emptied, so nothing Codex itself recorded stays. Calls made meanwhile wait for that.
	 */
	forget(): void;
	close(): Promise<void>;
};

/**
 * The Codex side of the cloud agents: long-lived app-server processes, the durable threads on them, and the
 * Eumenes-owned Codex home (`home`) they run in. The home is emptied at once; no process starts until the
 * first call, and one whose threads are all gone stops. Undefined when the CLI is not installed.
 */
export function createCodexHost(
	environment: Readonly<Record<string, string | undefined>>,
	options: {
		executable?: string;
		home: string;
		idleMs?: number;
		maxAgeMs?: number;
	},
): CodexHost | undefined {
	const runtime = codexRuntime(environment, options.executable);
	if (!runtime) return undefined;
	const personal =
		runtime.env.CODEX_HOME ??
		(runtime.env.HOME ? join(runtime.env.HOME, ".codex") : null);
	const home = createCodexHome(
		resolve(options.home),
		personal ? join(personal, "auth.json") : null,
	);
	// What an earlier backend left goes when this one starts, not at its first call.
	home.ready().catch(() => {});
	let inFlight = 0;
	let wipe: Promise<void> | undefined;
	let drained: ReturnType<typeof Promise.withResolvers<void>> | undefined;
	/** With no call under way: stop the processes that have no thread left (the last to go empties the home). */
	const settle = () => {
		if (inFlight) return;
		drained?.resolve();
		drained = undefined;
		if (!wipe) processes.sweep((rpc) => threads.has(rpc));
	};
	const enter = async () => {
		while (wipe) await wipe;
		inFlight++;
	};
	const leave = () => {
		inFlight--;
		settle();
	};
	const threads = createCodexThreads({
		idleMs: options.idleMs,
		maxAgeMs: options.maxAgeMs,
		removeRecords: (ids) => home.removeRecords(ids),
		onRetired: settle,
	});
	const processes = createCodexProcesses({
		runtime,
		home,
		async onExit(rpc, remaining) {
			const lost = threads.drop(rpc);
			if (remaining === 0) await home.reset();
			else await home.removeRecords(lost);
		},
	});
	const spec = (login: CodexLogin, webSearch: boolean) => ({
		...login,
		nativeWebSearch: webSearch,
	});
	return {
		async run(login, turn) {
			await enter();
			try {
				const rpc = await processes.connect(
					spec(login, turn.nativeWebSearch === true),
					turn.signal,
				);
				return await runCodexTurn({ rpc, threads, cwd: home.cwd }, turn, fail);
			} finally {
				leave();
			}
		},
		async models(login, signal) {
			await enter();
			const aborted = Promise.withResolvers<never>();
			aborted.promise.catch(() => {});
			const abort = () => aborted.reject(signal.reason ?? fail("cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			try {
				const rpc = await processes.connect(spec(login, false), signal);
				return await Promise.race([
					readCodexModels((method, params) => rpc.request(method, params)),
					aborted.promise,
				]);
			} finally {
				signal.removeEventListener("abort", abort);
				leave();
			}
		},
		forget() {
			threads.forget();
			wipe ??= (async () => {
				if (inFlight) await (drained ??= Promise.withResolvers<void>()).promise;
				// The last process to end empties the home (`onExit`).
				await processes.close();
			})()
				.catch(() => {})
				.finally(() => {
					wipe = undefined;
					settle();
				});
		},
		async close() {
			await processes.close();
			await threads.close();
		},
	};
}
