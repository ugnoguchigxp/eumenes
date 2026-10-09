import type { SqliteStore } from "../infrastructure/sqlite";
import { createForegroundHub, type ForegroundHub } from "../domains/world";

/**
 * The production foreground signal of World extraction (P4-03). Foreground is
 * whatever the user is waiting for right now:
 *
 *   - the queue's `interactive` lane (conversation answers and the work that
 *     belongs to the same turn): a job that is queued, waiting or running. A
 *     queued interactive job counts too - it is exactly the job that cannot
 *     start while a background extraction holds the Local LLM slot;
 *   - a request the inference service is running right now for conversation,
 *     ASR or TTS (voice turns do not go through the queue).
 *
 * Both are read-only probes. The hub re-evaluates them after every commit and
 * every request start/end and pushes a change to the subscribers; nothing here
 * polls or sleeps. Returned `stop` removes the subscriptions.
 */
export function createWorldForeground(input: {
	store: Pick<SqliteStore, "onCommit">;
	queue: {
		stats(): {
			lanes: Record<string, { queued: number; running: number }>;
		};
	};
	inference: {
		foregroundBusy(): boolean;
		onActivity(listener: () => void): () => void;
	};
}): { hub: ForegroundHub; stop(): void } {
	const hub = createForegroundHub();
	hub.addProbe(() => {
		const lane = input.queue.stats().lanes["interactive"];
		return lane !== undefined && lane.queued + lane.running > 0;
	});
	hub.addProbe(() => input.inference.foregroundBusy());
	const stops = [
		input.store.onCommit(() => hub.refresh()),
		input.inference.onActivity(() => hub.refresh()),
	];
	return {
		hub,
		stop() {
			for (const stop of stops.splice(0)) stop();
		},
	};
}
