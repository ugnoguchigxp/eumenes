import { AsyncResource } from "node:async_hooks";
import { getLogger } from "../../../infrastructure/logger";
import { recordStage } from "../../../infrastructure/performance";
import { fail } from "./cloud-agent-shared";
import type { CodexRpc, ThreadChannel, ThreadHandler } from "./codex-transport";
import { emptyTotals, type CodexTotals } from "./codex-usage";

const log = getLogger("inference");
const MAX_IDLE_PER_IDENTITY = 2;
const MAX_THREADS = 32;
export const IDLE_MS = 10 * 60_000;
/** A thread's record file keeps the text of reverted turns, so no thread lives longer than this. */
export const MAX_AGE_MS = 30 * 60_000;

export type ThreadMode = "new" | "append" | "reset";
/** The last response in the host's message format, hashed before the thread is released. */
export type ThreadReply = { digest: string; awaitsMore: boolean };
export type ThreadLease = {
	threadId: string;
	mode: ThreadMode;
	/** Index (into the call's messages past the instructions) of the first message this turn has to send. */
	sendFrom: number;
	/** The thread's cumulative counters when the turn begins (zero for a new or reverted thread). */
	baseline: CodexTotals;
	channel: ThreadChannel;
	/** The turn's handler; the thread's notifications and failures go to it until the turn ends. */
	listen(handler: ThreadHandler): void;
	turnStarted(turnId: string): void;
	/**
	 * The turn ended well. If the host can describe the answer it will use, a later call can prove it continues this turn.
	 */
	done(totals: CodexTotals | null, reply?: ThreadReply): void;
	/** No turn was started: the thread is as it was leased. */
	untouched(): void;
	/** The turn was interrupted and ended: the thread stays, to be reverted before it is used again. */
	interrupted(): void;
	/** The thread can not be trusted: it is deleted. */
	discard(): Promise<void>;
};

type Continuation = {
	requestId: string;
	covered: string[];
	awaitsMore: boolean;
};

type Entry = {
	id: string;
	rpc: CodexRpc;
	identity: string;
	continuation?: Continuation;
	busy: boolean;
	gone: boolean;
	/** Something was forgotten while the thread ran a turn: it is deleted when that turn ends. */
	doomed: boolean;
	created: number;
	firstTurnId: string | null;
	totals: CodexTotals;
	idleSince: number;
	timer?: ReturnType<typeof setTimeout>;
	channel?: ThreadChannel;
	handler: ThreadHandler | null;
};

/** One request may append when its input starts with exactly what the thread holds, including the answer. */
function continues(
	previous: Continuation,
	requestId: string | undefined,
	messages: readonly string[],
) {
	return (
		previous.requestId === requestId &&
		messages.length > previous.covered.length &&
		previous.covered.every((digest, i) => messages[i] === digest)
	);
}

/**
 * The durable threads of the app-servers. A thread keeps one head (the Codex text, the host's instructions and the
 * output schema), so a request that starts from it reaches the same input cache. A call either appends to a
 * thread whose content it continues, or has the thread reverted to its head and sends everything, or starts a new
 * thread. A thread runs one turn at a time.
 */
export function createCodexThreads(options: {
	idleMs?: number;
	maxAgeMs?: number;
	now?: () => number;
	/** A thread's deletion ended: its process may have none left. */
	onRetired?(): void;
	/** Record files of threads that could not be deleted through their process. */
	removeRecords(threadIds: readonly string[]): Promise<void>;
}) {
	const idleMs = options.idleMs ?? IDLE_MS;
	const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
	const now = options.now ?? Date.now;
	const entries = new Set<Entry>();
	const deleting = new Set<Promise<void>>();
	/** Deletions under way per process: it is not without threads until they end. */
	const leaving = new Map<CodexRpc, number>();

	function retire(entry: Entry): Promise<void> {
		if (entry.gone) return Promise.resolve();
		entry.gone = true;
		entries.delete(entry);
		clearTimeout(entry.timer);
		entry.channel?.detach();
		entry.handler = null;
		if (!entry.id) return Promise.resolve();
		const { id, rpc } = entry;
		leaving.set(rpc, (leaving.get(rpc) ?? 0) + 1);
		const done = (
			rpc.alive
				? rpc.request("thread/delete", { threadId: id })
				: Promise.reject(fail("incomplete_turn"))
		)
			.then(
				() => undefined,
				() => options.removeRecords([id]),
			)
			.catch(() => {})
			.finally(() => {
				deleting.delete(done);
				const left = leaving.get(rpc)! - 1;
				if (left) leaving.set(rpc, left);
				else leaving.delete(rpc);
				options.onRetired?.();
			});
		deleting.add(done);
		return done;
	}
	function enforce(entry: Entry) {
		const idle = (e: Entry) => !e.busy && !e.gone;
		const oldest = (list: Entry[]) =>
			list.reduce((a, b) => (b.idleSince < a.idleSince ? b : a));
		const same = [...entries].filter(
			(e) => idle(e) && e.rpc === entry.rpc && e.identity === entry.identity,
		);
		if (same.length > MAX_IDLE_PER_IDENTITY) void retire(oldest(same));
		while (entries.size > MAX_THREADS) {
			const idles = [...entries].filter(idle);
			if (!idles.length) break;
			void retire(oldest(idles));
		}
	}
	function release(entry: Entry) {
		entry.busy = false;
		entry.handler = null;
		entry.idleSince = now();
		if (entry.doomed || entry.idleSince - entry.created >= maxAgeMs) {
			void retire(entry);
			return;
		}
		entry.timer = setTimeout(() => {
			if (!entry.busy) void retire(entry);
		}, idleMs);
		entry.timer.unref?.();
		enforce(entry);
	}

	return {
		async acquire(input: {
			rpc: CodexRpc;
			identity: string;
			messages: readonly string[];
			requestId?: string;
			/** `thread/start` parameters of a new thread. */
			start: Record<string, unknown>;
			attemptId?: string;
			connectionId?: string;
		}): Promise<ThreadLease> {
			const startedAt = performance.now();
			const idle = [...entries].filter(
				(e) =>
					e.rpc === input.rpc &&
					e.identity === input.identity &&
					!e.busy &&
					!e.gone,
			);
			const candidates = idle
				.filter(
					(e): e is Entry & { continuation: Continuation } =>
						!!e.continuation &&
						continues(e.continuation, input.requestId, input.messages),
				)
				.sort(
					(a, b) =>
						b.continuation.covered.length - a.continuation.covered.length,
				);
			// Equal matches leave the previous turn ambiguous.
			const following =
				candidates[1]?.continuation.covered.length ===
				candidates[0]?.continuation.covered.length
					? undefined
					: candidates[0];
			// A thread whose answer asked for something is left for the call that continues it, while there is room.
			const free = idle
				.filter((e) => !e.continuation?.awaitsMore)
				.sort((a, b) => b.idleSince - a.idleSince)[0];
			const reusable =
				following ??
				free ??
				(idle.length >= MAX_IDLE_PER_IDENTITY
					? idle.sort((a, b) => a.idleSince - b.idleSince)[0]
					: undefined);
			const mode: ThreadMode = following
				? "append"
				: reusable
					? "reset"
					: "new";
			const entry: Entry = reusable ?? {
				id: "",
				rpc: input.rpc,
				identity: input.identity,
				busy: true,
				gone: false,
				doomed: false,
				created: now(),
				firstTurnId: null,
				totals: emptyTotals,
				idleSince: 0,
				handler: null,
			};
			entry.busy = true;
			clearTimeout(entry.timer);
			if (!reusable) entries.add(entry);
			const fields = {
				mode,
				...(input.attemptId ? { attemptId: input.attemptId } : {}),
				...(input.connectionId ? { connectionId: input.connectionId } : {}),
			};
			let outcome: "ok" | "error" = "error";
			try {
				if (mode === "new") {
					const started = (await input.rpc.request(
						"thread/start",
						input.start,
					)) as { thread?: { id?: string } };
					if (!started?.thread?.id) throw fail("codex_turn_failed");
					entry.id = started.thread.id;
					entry.channel = input.rpc.attach(entry.id, {
						notify: (method, params) => entry.handler?.notify(method, params),
						fail: (error) => entry.handler?.fail(error),
					});
				} else if (mode === "reset") {
					if (entry.firstTurnId)
						await input.rpc.request("thread/revert", {
							threadId: entry.id,
							beforeTurnId: entry.firstTurnId,
						});
					entry.firstTurnId = null;
					entry.continuation = undefined;
					entry.totals = emptyTotals;
				}
				outcome = "ok";
			} catch (error) {
				await retire(entry);
				throw error;
			} finally {
				recordStage(
					"inference",
					"codex_thread_ready",
					startedAt,
					outcome,
					fields,
				);
			}
			log.info("inference.codex_thread", {
				...fields,
				count: entries.size,
			});
			return {
				threadId: entry.id,
				mode,
				sendFrom: following?.continuation.covered.length ?? 0,
				baseline: entry.totals,
				channel: entry.channel!,
				listen(handler) {
					// The shared process emits in its first caller's async context. Bind each
					// lease, including reused threads, to the current run for deltas and usage.
					entry.handler = {
						notify: AsyncResource.bind(handler.notify),
						fail: AsyncResource.bind(handler.fail),
					};
				},
				turnStarted(turnId) {
					entry.firstTurnId ??= turnId;
				},
				done(totals, reply) {
					if (entry.gone) return;
					entry.continuation =
						input.requestId && reply
							? {
									requestId: input.requestId,
									covered: [...input.messages, reply.digest],
									awaitsMore: reply.awaitsMore,
								}
							: undefined;
					entry.totals = totals ?? entry.totals;
					release(entry);
				},
				untouched() {
					if (!entry.gone) release(entry);
				},
				interrupted() {
					if (entry.gone) return;
					entry.continuation = undefined;
					release(entry);
				},
				discard: () => retire(entry),
			};
		},
		/**
		 * A forgotten reference may be in any thread: all of them are deleted, the ones running a turn when that
		 * turn ends (its call goes on; an attempt that stood on the forgotten reference is revoked by its owner).
		 */
		forget() {
			for (const entry of entries)
				if (entry.busy) entry.doomed = true;
				else void retire(entry);
		},
		/** Whether a process still has a thread. */
		has(rpc: CodexRpc) {
			if (leaving.has(rpc)) return true;
			for (const entry of entries) if (entry.rpc === rpc) return true;
			return false;
		},
		/** The threads of a process that ended; nothing can be asked of it any more. */
		drop(rpc: CodexRpc) {
			const ids: string[] = [];
			for (const entry of entries)
				if (entry.rpc === rpc) {
					if (entry.id) ids.push(entry.id);
					entry.gone = true;
					entries.delete(entry);
					clearTimeout(entry.timer);
					entry.handler = null;
				}
			return ids;
		},
		async close() {
			for (const entry of entries) {
				clearTimeout(entry.timer);
				entry.gone = true;
			}
			entries.clear();
			await Promise.allSettled(deleting);
		},
	};
}
export type CodexThreads = ReturnType<typeof createCodexThreads>;
