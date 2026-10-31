import { useEffect, useState } from "react";
import { ApiError } from "../../../client/transport";

/** LARM had no free memory for an on-demand start; the backend answers 503 `{ error, retryAfterMs }`. */
export const capacityBusy = "larm_capacity_busy";
export const capacityWaitingMessage =
	"LARMの空きを待っています。ほかの処理が終わりしだい始めます。";
export const capacityTimeoutMessage =
	"LARMの空きを待ちましたが、待てる時間内に空かなかったため中止しました。";
const retryMs = 30_000;
const retryLimitMs = 300_000;
const waitLimitMs = 30 * 60_000;

/**
 * The wait the backend asks for after a capacity refusal (its 503 body, or an error a domain raised with
 * the same code and wait), or `null` for any other error.
 */
export function capacityBusyOf(error: unknown) {
	if (!(error instanceof Error) || error.message !== capacityBusy) return null;
	if (error instanceof ApiError && error.status !== 503) return null;
	const ms =
		error instanceof ApiError
			? (error.body as { retryAfterMs?: unknown } | undefined)?.retryAfterMs
			: (error as { retryAfterMs?: unknown }).retryAfterMs;
	return {
		retryAfterMs: typeof ms === "number" && Number.isFinite(ms) ? ms : null,
	};
}

/**
 * The one timer that sends a refused request again: after the longer of 30 s and LARM's wait, until
 * 30 minutes have passed since the first refusal.
 */
export function createCapacityWait(options: {
	clock?: () => number;
	onChange?: (waiting: boolean) => void;
}) {
	const clock = options.clock ?? Date.now;
	let timer: ReturnType<typeof setTimeout> | null = null,
		firstAt: number | null = null;
	const stopTimer = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};
	const reset = () => {
		const was = timer !== null;
		stopTimer();
		firstAt = null;
		if (was) options.onChange?.(false);
	};
	return {
		/** True from a refusal until its timer fires or the wait is reset. */
		waiting: () => timer !== null,
		/** Schedules the single next send, or reports that the wait limit has passed. */
		refuse(retryAfterMs: number | null, send: () => void) {
			const now = clock();
			firstAt ??= now;
			const delay = Math.min(
				Math.max(retryMs, retryAfterMs ?? 0),
				retryLimitMs,
			);
			if (now + delay - firstAt > waitLimitMs) {
				reset();
				return "expired" as const;
			}
			stopTimer();
			timer = setTimeout(() => {
				timer = null;
				options.onChange?.(false);
				send();
			}, delay);
			options.onChange?.(true);
			return "waiting" as const;
		},
		/** A new request starts for another reason: the pending timer must not send a second one. */
		supersede() {
			const was = timer !== null;
			stopTimer();
			if (was) options.onChange?.(false);
		},
		/** The request succeeded, failed otherwise, or was started by the person: count anew. */
		reset,
	};
}

export function useCapacityWait() {
	const [waiting, setWaiting] = useState(false);
	const [wait] = useState(() => createCapacityWait({ onChange: setWaiting }));
	// Closing the artifact stops the timer.
	useEffect(() => () => wait.reset(), [wait]);
	return { wait, waiting };
}
