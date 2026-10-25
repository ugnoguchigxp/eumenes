export const DEFAULT_VOICE_SILENCE_TIMEOUT_MS = 1_500;
const DEFAULT_SPEECH_THRESHOLD_RMS = 0.008;
const DEFAULT_REQUIRED_SPEECH_MS = 240;
const DEFAULT_CANDIDATE_RESET_MS = 200;
/** Speech has gaps within this span, so its quietest frame is the room, not the voice. */
const NOISE_WINDOW_MS = 1_500;
/** Speech must be this many times the noise floor. */
const NOISE_MARGIN = 3;

type VoiceActivityDetectorOptions = {
	sampleRate: number;
	speechThresholdRms?: number;
	requiredSpeechMs?: number;
	silenceTimeoutMs?: number;
	candidateResetMs?: number;
};

export type VoiceActivityObservation = {
	hasSpeech: boolean;
	shouldFinalize: boolean;
	rms: number;
};

export class VoiceActivityDetector {
	private readonly speechThresholdRms: number;
	private readonly requiredSpeechSamples: number;
	private readonly silenceTimeoutSamples: number;
	private readonly candidateResetSamples: number;
	private readonly noiseWindowSamples: number;
	/** Recent frame levels feeding the noise floor, oldest first. */
	private noise: Array<{ rms: number; samples: number }> = [];
	private noiseSamples = 0;
	/** Moving average used until a full window is heard. */
	private warmupFloor = 0;
	private speechSamples = 0;
	private candidateSilenceSamples = 0;
	private silenceSamples = 0;
	private speechDetected = false;
	private finalized = false;

	constructor({
		sampleRate,
		speechThresholdRms = DEFAULT_SPEECH_THRESHOLD_RMS,
		requiredSpeechMs = DEFAULT_REQUIRED_SPEECH_MS,
		silenceTimeoutMs = DEFAULT_VOICE_SILENCE_TIMEOUT_MS,
		candidateResetMs = DEFAULT_CANDIDATE_RESET_MS,
	}: VoiceActivityDetectorOptions) {
		if (!Number.isFinite(sampleRate) || sampleRate <= 0)
			throw new RangeError("sampleRate must be positive");
		if (!Number.isFinite(speechThresholdRms) || speechThresholdRms <= 0)
			throw new RangeError("speechThresholdRms must be positive");
		this.speechThresholdRms = speechThresholdRms;
		this.requiredSpeechSamples = millisecondsToSamples(
			requiredSpeechMs,
			sampleRate,
		);
		this.silenceTimeoutSamples = millisecondsToSamples(
			silenceTimeoutMs,
			sampleRate,
		);
		this.candidateResetSamples = millisecondsToSamples(
			candidateResetMs,
			sampleRate,
		);
		this.noiseWindowSamples = millisecondsToSamples(
			NOISE_WINDOW_MS,
			sampleRate,
		);
	}

	/** Starts the next utterance; the learned noise floor is kept. */
	restart() {
		this.speechSamples = 0;
		this.candidateSilenceSamples = 0;
		this.silenceSamples = 0;
		this.speechDetected = false;
		this.finalized = false;
	}

	/**
	 * The quietest recent frame. Until a full window is heard (just after the microphone opens), a
	 * moving average of the frames heard so far stands in for it.
	 */
	private noiseFloor() {
		if (this.noiseSamples < this.noiseWindowSamples) return this.warmupFloor;
		let floor = Infinity;
		for (const { rms } of this.noise) floor = Math.min(floor, rms);
		return floor;
	}

	private learnNoise(rms: number, samples: number) {
		this.warmupFloor = 0.95 * this.warmupFloor + 0.05 * rms;
		this.noise.push({ rms, samples });
		this.noiseSamples += samples;
		while (
			this.noise.length > 1 &&
			this.noiseSamples - this.noise[0]!.samples >= this.noiseWindowSamples
		)
			this.noiseSamples -= this.noise.shift()!.samples;
	}

	hasDetectedSpeech(): boolean {
		return this.speechDetected;
	}

	observe(frame: Float32Array): VoiceActivityObservation {
		const rms = calculateRms(frame);
		if (this.finalized || frame.length === 0) {
			return { hasSpeech: this.speechDetected, shouldFinalize: false, rms };
		}

		const threshold = Math.max(
			this.speechThresholdRms,
			this.noiseFloor() * NOISE_MARGIN,
		);
		const voiced = rms >= threshold;
		// The room is learned only outside speech: a voice onset cannot lift the minimum, and the
		// quiet parts of an utterance cannot creep the threshold up until it cuts the speaker off.
		if (!this.speechDetected) this.learnNoise(rms, frame.length);
		if (!this.speechDetected) {
			if (voiced) {
				this.speechSamples += frame.length;
				this.candidateSilenceSamples = 0;
				if (this.speechSamples >= this.requiredSpeechSamples) {
					this.speechDetected = true;
					this.silenceSamples = 0;
				}
			} else if (this.speechSamples > 0) {
				this.candidateSilenceSamples += frame.length;
				if (this.candidateSilenceSamples >= this.candidateResetSamples) {
					this.speechSamples = 0;
					this.candidateSilenceSamples = 0;
				}
			}
			return { hasSpeech: this.speechDetected, shouldFinalize: false, rms };
		}

		if (voiced) {
			this.silenceSamples = 0;
			return { hasSpeech: true, shouldFinalize: false, rms };
		}

		this.silenceSamples += frame.length;
		if (this.silenceSamples < this.silenceTimeoutSamples) {
			return { hasSpeech: true, shouldFinalize: false, rms };
		}

		this.finalized = true;
		return { hasSpeech: true, shouldFinalize: true, rms };
	}
}

function millisecondsToSamples(
	milliseconds: number,
	sampleRate: number,
): number {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0)
		throw new RangeError("duration must be positive");
	return Math.ceil((milliseconds / 1_000) * sampleRate);
}

function calculateRms(frame: Float32Array): number {
	if (frame.length === 0) return 0;
	let sum = 0;
	for (const sample of frame) sum += sample;
	const mean = sum / frame.length;
	let sumOfSquares = 0;
	for (const sample of frame) {
		const centered = sample - mean;
		sumOfSquares += centered * centered;
	}
	return Math.sqrt(sumOfSquares / frame.length);
}
