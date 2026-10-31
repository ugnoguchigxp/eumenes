/**
 * Speech synthesis runs one request at a time across the service (spec tts-single-lane §4.5), so
 * the provider never sees two clauses at once. Turns are taken in arrival order; a waiter that is
 * cancelled leaves the line without being sent and hands its turn on when the one before it ends.
 */
export function createSpeechLane() {
	let tail: Promise<void> = Promise.resolve();
	let queued = 0;
	return {
		async run<T>(
			signal: AbortSignal,
			work: () => Promise<T>,
			onTurn?: (waitedMs: number, ahead: number) => void,
		): Promise<T> {
			const ahead = queued++;
			const previous = tail;
			let release: () => void = () => {};
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = performance.now();
			try {
				signal.throwIfAborted();
				let abort: () => void = () => {};
				try {
					await Promise.race([
						previous,
						new Promise<never>((_, reject) => {
							// A machine-readable code: a deadline passed while waiting, or the caller left.
							abort = () =>
								reject(
									new Error(
										signal.reason instanceof DOMException &&
											signal.reason.name === "TimeoutError"
											? "speech_lane_timeout"
											: "cancelled",
									),
								);
							signal.addEventListener("abort", abort, { once: true });
						}),
					]);
				} finally {
					signal.removeEventListener("abort", abort);
				}
				onTurn?.(performance.now() - started, ahead);
				return await work();
			} finally {
				queued--;
				void previous.then(release);
			}
		},
	};
}
export type SpeechLane = ReturnType<typeof createSpeechLane>;
