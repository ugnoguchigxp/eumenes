import type { TimingIdentity } from "../../../performance";

/** Browser-local output diagnosis. Identifiers only; never text, audio or credentials. */
export function createPlaybackTrace() {
	const controllerId = crypto.randomUUID();
	return (identity: TimingIdentity = {}) => {
		const playbackId = crypto.randomUUID();
		return (stage: string) => {
			try {
				console.info(
					"eumenes.audio_playback",
					JSON.stringify({
						controllerId,
						playbackId,
						stage,
						runId: identity.runId,
						utteranceId: identity.utteranceId,
						chunkIndex: identity.chunkIndex,
					}),
				);
			} catch {
				// Diagnosis cannot change playback.
			}
		};
	};
}

type ObservedOptions = {
	timing?: TimingIdentity;
	onStarted?: () => void;
	onInterrupted?: () => void;
};

/** Observes the existing play call and callbacks without replacing its routing or cancellation. */
export function traceAudioOutput<
	T extends {
		play(
			bytes: Uint8Array,
			ended: () => void,
			options?: ObservedOptions,
		): Promise<void>;
	},
>(output: T): T {
	const request = createPlaybackTrace();
	const play = output.play;
	output.play = async (bytes, ended, options = {}) => {
		const trace = request(options.timing);
		trace("requested");
		let started = false;
		try {
			await play.call(
				output,
				bytes,
				() => {
					trace("ended");
					ended();
				},
				{
					...options,
					onStarted: () => {
						started = true;
						trace("started");
						options.onStarted?.();
					},
					onInterrupted: () => {
						trace("interrupted");
						options.onInterrupted?.();
					},
				},
			);
			if (!started) trace("discarded");
		} catch (error) {
			trace("failed");
			throw error;
		}
	};
	return output;
}
