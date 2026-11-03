import { analyseAssistantSpeech } from "../assistant-speech";

/** One audible connection and an optional silent analysis tap, released together. */
export function connectPlaybackOutput(
	context: AudioContext,
	source: AudioBufferSourceNode,
	volume: number,
	assistantSpeech: boolean,
) {
	if (!Number.isFinite(volume) || volume < 0 || volume > 1)
		throw new Error("audio_volume_invalid");
	let gain: GainNode | undefined;
	if (volume !== 1) {
		gain = context.createGain();
		gain.gain.value = volume;
		source.connect(gain);
		gain.connect(context.destination);
	} else source.connect(context.destination);
	const release = assistantSpeech
		? analyseAssistantSpeech(context, gain ?? source, () => true)
		: undefined;
	return () => {
		release?.();
		source.disconnect();
		gain?.disconnect();
	};
}
