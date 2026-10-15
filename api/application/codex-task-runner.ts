import { getLogger } from "../infrastructure/logger";
import type { SqliteStore } from "../infrastructure/sqlite";
import type { CodexTasks, CodexAttempt } from "../domains/codex-tasks";
import {
	sdkTerminal,
	codingCanonicalJSON,
	type sdkRunnerClient,
} from "../domains/coding";

type Runner = ReturnType<typeof sdkRunnerClient>;
/** Network calls happen outside the writer; a durable publication intent precedes each start. */
export function connectCodexTaskRunner(options: {
	store: SqliteStore;
	tasks: CodexTasks;
	runner: (id: string) => Runner | undefined;
	adoptInTransaction: (
		tx: Parameters<CodexTasks["observeInTransaction"]>[0],
		attempt: CodexAttempt,
	) => void;
	onUnavailable?: (attemptId: string) => void;
}) {
	let closed = false;
	let inflight: Promise<void> | undefined;
	const unavailable = new Map<string, string>();
	async function synchronize(current: CodexAttempt) {
		const runner = options.runner(current.runnerId);
		if (!runner) {
			options.onUnavailable?.(current.id);
			return;
		}
		if (!current.published) {
			const publish = await options.store.write((tx) =>
				options.tasks.beginPublishInTransaction(tx, current.id),
			);
			if (publish) await runner.start(current.spec);
		}
		const frame = await runner.events(current.id, current.seq, 100);
		// Repeated reads of the same active receipt carry no new execution facts.
		// Avoid invalidating the board again while its snapshot is being read.
		if (
			!current.stopRequested &&
			!sdkTerminal(frame.receipt.state) &&
			frame.events.length === 0 &&
			current.receipt &&
			codingCanonicalJSON(current.receipt) ===
				codingCanonicalJSON(frame.receipt)
		)
			return;
		await options.store.write((tx) => {
			const observed = options.tasks.observeInTransaction(
				tx,
				current.scope,
				current.id,
				frame,
			);
			if (!observed) return;
			options.adoptInTransaction(tx, observed);
			if (observed.receipt && sdkTerminal(observed.state))
				options.tasks.markAdoptedInTransaction(tx, observed.id);
		});
		if (current.stopRequested && !sdkTerminal(frame.receipt.state))
			await runner.stop(current.id, `stop-${current.id}`);
	}
	function flush(): Promise<void> {
		if (closed) return Promise.resolve();
		if (inflight) return inflight;
		inflight = (async () => {
			const pending = options.tasks.pending();
			const ids = new Set(pending.map((a) => a.id));
			for (const id of unavailable.keys())
				if (!ids.has(id)) unavailable.delete(id);
			for (const current of pending) {
				if (closed) break;
				try {
					await synchronize(current);
					unavailable.delete(current.id);
				} catch (error) {
					const reason =
						error instanceof Error &&
						/^(codex|sdk|kanban)_[a-z_]+$/.test(error.message)
							? error.message
							: "codex_synchronize_failed";
					if (unavailable.get(current.id) !== reason) {
						unavailable.set(current.id, reason);
						getLogger("codex-tasks").warn("codex.synchronize_unavailable", {
							attemptId: current.id,
							reason,
						});
					}
					if (
						error instanceof Error &&
						error.message === "sdk_execution_missing"
					)
						await options.store.write((tx) => {
							const lost = options.tasks.markTrackingLostInTransaction(
								tx,
								current.id,
							);
							if (lost) {
								options.adoptInTransaction(tx, lost);
								options.tasks.markAdoptedInTransaction(tx, lost.id);
							}
						});
					options.onUnavailable?.(current.id);
				}
			}
		})().finally(() => {
			inflight = undefined;
		});
		return inflight;
	}
	const safeFlush = () => {
		void flush().catch(() =>
			getLogger("codex-tasks").warn("codex.synchronize_failed", {
				reason: "persistence_failed",
			}),
		);
	};
	const unsubscribe = options.store.onCommit(() => {
		safeFlush();
	});
	const timer = setInterval(() => {
		safeFlush();
	}, 1000);
	timer.unref();
	return {
		flush,
		async disconnect() {
			closed = true;
			clearInterval(timer);
			unsubscribe();
			await inflight;
		},
	};
}
