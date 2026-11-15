import type { AudioController } from "../../audio";

/** Resolve at playback end, independently of when synthesis or decoding finished. */
export function playClause(
	target: Pick<AudioController, "play" | "stopPlayback">,
	wav: Uint8Array,
	signal: AbortSignal,
	options: NonNullable<Parameters<AudioController["play"]>[2]>,
	ended: () => void,
	ownsOutput: () => boolean,
) {
	return new Promise<{ started: boolean; interrupted: boolean }>(
		(resolve, reject) => {
			let started = false,
				interrupted = false,
				finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				signal.removeEventListener("abort", abort);
				ended();
				resolve({ started, interrupted });
			};
			const abort = () => {
				interrupted = true;
				if (started && ownsOutput()) target.stopPlayback();
				finish();
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			void target
				.play(wav, finish, {
					...options,
					waitForPrevious: true,
					onStarted: () => {
						started = true;
						options.onStarted?.();
					},
					onInterrupted: () => {
						interrupted = true;
						options.onInterrupted?.();
						finish();
					},
				})
				.then(
					() => {
						if (!started) finish();
					},
					(cause) => {
						signal.removeEventListener("abort", abort);
						reject(cause);
					},
				);
		},
	);
}
