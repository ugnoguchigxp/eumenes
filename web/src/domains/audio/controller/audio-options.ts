export type LostReason =
	| "mic_lost"
	| "audio_context_lost"
	| "audio_output_lost"
	| "voice_detector_unavailable";
export type AudioOptions = {
	inputDevice?: string;
	outputDevice?: string;
	threshold?: number;
	silenceMs?: number;
	echoCancellation?: boolean;
	noiseSuppression?: boolean;
	autoGainControl?: boolean;
	onPartial?: (wav: Uint8Array) => void;
	/**
	 * Half duplex: while our own speech plays (and briefly after, for output
	 * latency such as Bluetooth) the microphone is treated as silent, so the
	 * reply is never recognized as the next utterance. Evaluated per frame.
	 */
	halfDuplex?: () => boolean;
	/** Keep the output device awake with an inaudible bed (default on). */
	keepAlive?: boolean;
	/** The microphone or audio output went away; the session cannot continue. */
	onLost?: (reason: LostReason) => void;
	onNotice?: (reason: "saved_device_missing" | "recording_limit") => void;
};

export type AudioSession = {
	context: AudioContext | undefined;
	disposed: boolean;
};
