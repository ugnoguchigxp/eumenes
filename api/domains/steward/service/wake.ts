import { getLogger } from "../../../infrastructure/logger";
import {
	CAPTURE_RETRY_MAX_MS,
	CAPTURE_RETRY_MS,
	RETRY_DELAYS_MS,
	type UnitSlot,
} from "../contracts";
import type { StewardDeps } from "./types";

const log = getLogger("steward");

/** The wait after `failures` failed tries over the same target. */
export const retryDelay = (failures: number) =>
	RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]!;

const defaultTimer = (run: () => void, ms: number) => {
	const timer = setTimeout(run, ms);
	timer.unref();
	return () => clearTimeout(timer);
};

/**
 * Waiting without the queue. A job enqueued for later holds its `concurrencyKey` for everything behind it (the
 * queue is first-in-first-out per key whatever `available_at` says), so the steward never enqueues a job for a
 * future time. What has to wait (a deferred upkeep, a failed target's retry, a request that could not be taken)
 * is remembered here, and one in-process timer (unref'd) kicks the steward when the earliest of them is due.
 * Nothing is stored: after a restart the startup kick looks at the same state and decides again.
 */
export function createWake(deps: StewardDeps) {
	const setTimer = deps.setTimer ?? defaultTimer;
	const pauses = new Map<string, number>();
	const captureFailures = new Map<string, number>();
	let cancel: (() => void) | null = null;
	let dueAt: number | null = null;
	let fire: () => Promise<void> = async () => {};

	function at(ms: number) {
		if (dueAt !== null && dueAt <= ms) return;
		cancel?.();
		dueAt = ms;
		cancel = setTimer(
			() => {
				cancel = null;
				dueAt = null;
				void run();
			},
			Math.max(0, ms - deps.nowMs()),
		);
	}

	async function run() {
		const now = deps.nowMs();
		for (const [key, until] of pauses) if (until <= now) pauses.delete(key);
		try {
			await fire();
		} catch (error) {
			log.warn("steward.wake_failed", { reason: "kick_failed" }, error);
		}
		const next = Math.min(...pauses.values());
		if (Number.isFinite(next)) at(next);
	}

	const keyOf = (conversationId: string, slot: UnitSlot) =>
		`${conversationId}:${slot}`;

	return {
		/** What to do when the timer is due: kick every conversation. */
		onWake(run: () => Promise<void>) {
			fire = run;
		},
		/** Kick the steward at this time (an earlier request wins). */
		at,
		/** A failed unit's targets are not tried again before `until`. */
		pause(conversationId: string, slot: UnitSlot, until: number) {
			const key = keyOf(conversationId, slot);
			pauses.set(key, Math.max(pauses.get(key) ?? 0, until));
			at(until);
		},
		paused(conversationId: string, slot: UnitSlot): boolean {
			const key = keyOf(conversationId, slot);
			const until = pauses.get(key);
			if (until === undefined) return false;
			if (until <= deps.nowMs()) {
				pauses.delete(key);
				return false;
			}
			at(until);
			return true;
		},
		/** A step could not take its inference request: try again later (30 s, doubling to 5 min). */
		captureFailed(conversationId: string, slot: UnitSlot) {
			const key = keyOf(conversationId, slot);
			const earlier = captureFailures.get(key) ?? 0;
			captureFailures.set(key, earlier + 1);
			at(
				deps.nowMs() +
					Math.min(CAPTURE_RETRY_MS * 2 ** earlier, CAPTURE_RETRY_MAX_MS),
			);
		},
		captureSucceeded(conversationId: string, slot: UnitSlot) {
			captureFailures.delete(keyOf(conversationId, slot));
		},
	};
}
export type Wake = ReturnType<typeof createWake>;
