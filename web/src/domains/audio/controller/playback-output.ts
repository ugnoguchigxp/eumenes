import { analyseAssistantSpeech } from "../assistant-speech";

const DUCKED_SPEECH_GAIN = 0.01;

/** One audible connection and an optional silent analysis tap, released together. */
export function connectPlaybackOutput(
	context: AudioContext,
	source: AudioBufferSourceNode,
	volume: number,
	assistantSpeech: boolean,
	ducked: boolean,
) {
	if (!Number.isFinite(volume) || volume < 0 || volume > 1)
		throw new Error("audio_volume_invalid");
	let gain: GainNode | undefined;
	if (assistantSpeech || volume !== 1) {
		gain = context.createGain();
		gain.gain.value =
			assistantSpeech && ducked ? volume * DUCKED_SPEECH_GAIN : volume;
		source.connect(gain);
		gain.connect(context.destination);
	} else source.connect(context.destination);
	const release = assistantSpeech
		? analyseAssistantSpeech(context, gain ?? source, () => true)
		: undefined;
	return {
		setDucked(active: boolean) {
			if (!assistantSpeech || !gain || volume === 0 || ducked === active)
				return;
			ducked = active;
			gain.gain.setTargetAtTime(
				active ? volume * DUCKED_SPEECH_GAIN : volume,
				context.currentTime,
				active ? 0.005 : 0.02,
			);
		},
		release() {
			release?.();
			source.disconnect();
			gain?.disconnect();
		},
	};
}
