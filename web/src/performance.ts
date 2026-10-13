export type TimingIdentity = {
	runId?: string;
	utteranceId?: string;
	chunkIndex?: number;
};
type Phase =
	| "text_received"
	| "text_committed"
	| "audio_fetch"
	| "audio_decode"
	| "playback_scheduled";

/** Local, bounded User Timing entries. No network upload or user content. */
export function browserTiming(
	phase: Phase,
	identity: TimingIdentity,
	started = performance.now(),
) {
	try {
		const name = `eumenes.${phase}`;
		if (performance.getEntriesByName(name, "measure").length >= 64)
			performance.clearMeasures(name);
		performance.measure(name, {
			start: started,
			end: performance.now(),
			detail: identity,
		});
	} catch {
		// Older browsers and unavailable performance APIs cannot block playback.
	}
}

export async function timedAudioDecode(
	context: AudioContext,
	bytes: Uint8Array,
	identity: TimingIdentity = {},
) {
	const started = performance.now();
	const buffer = await context.decodeAudioData(new Uint8Array(bytes).buffer);
	browserTiming("audio_decode", identity, started);
	return buffer;
}
