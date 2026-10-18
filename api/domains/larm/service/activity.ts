import {
	isNetworkError,
	toErrorCode,
} from "../../../infrastructure/error-code";
import type {
	ActivityObservation,
	ActivityRecorder,
} from "../contracts/activity";

/** In-memory only: a restart forgets the outcomes and the owner reports them as unknown. */
export function createActivityRecorder(now = Date.now): ActivityRecorder {
	let running = 0;
	let lastSuccessAt: number | null = null;
	let lastFailure: ActivityObservation["lastFailure"] = null;
	return {
		async track(call, signal) {
			running += 1;
			try {
				signal?.throwIfAborted();
				const value = await call();
				signal?.throwIfAborted();
				lastSuccessAt = now();
				return value;
			} catch (error) {
				const timedOut =
					signal?.reason instanceof DOMException &&
					signal.reason.name === "TimeoutError";
				if (!signal?.aborted || timedOut)
					lastFailure = {
						at: now(),
						reason: timedOut
							? "deadline_exceeded"
							: isNetworkError(error)
								? "network_unavailable"
								: toErrorCode(error, "failed"),
					};
				throw error;
			} finally {
				running -= 1;
			}
		},
		observe: () => ({ running, lastSuccessAt, lastFailure }),
	};
}
