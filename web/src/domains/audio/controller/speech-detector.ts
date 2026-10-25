import { createResampler } from "./resample";
import { SPEECH_WINDOW } from "./speech-model";
import type { SpeechClassifier } from "./speech-classifier";

export const DEFAULT_VOICE_SILENCE_TIMEOUT_MS = 1_500;
const DEFAULT_MINIMUM_RMS = 0.008;
/** A window turns voiced at this probability and stays voiced until it falls below SPEECH_OFF. */
const SPEECH_ON = 0.5;
const SPEECH_OFF = 0.35;
/** While our own reply plays (or just after), its voice can reach the microphone. */
const STRICT_SPEECH_ON = 0.8;
const REQUIRED_SPEECH_MS = 200;
const STRICT_REQUIRED_SPEECH_MS = 400;
/** A pause this long before speech is confirmed starts the count again. */
const CANDIDATE_RESET_MS = 200;
const WINDOW_MS = (SPEECH_WINDOW / 16_000) * 1000;

export type SpeechObservation = {
	hasSpeech: boolean;
	shouldFinalize: boolean;
	rms: number;
};

/**
 * Finds utterances with a learned voice model: speech starts after enough voiced windows and
 * ends after `silenceTimeoutMs` without them. A classifier that answers asynchronously is applied
 * on a later frame, in order; the recording keeps a pre-roll for that delay.
 */
export class SpeechDetector {
	private readonly classifier: SpeechClassifier;
	private readonly minimumRms: number;
	private readonly silenceTimeoutMs: number;
	private readonly resampler: ReturnType<typeof createResampler>;
	private readonly window = new Float32Array(SPEECH_WINDOW);
	private filled = 0;
	/** Windows sent and the next one to apply; results may arrive out of turn. */
	private sent = 0;
	private applied = 0;
	private readonly results = new Map<number, { p: number; rms: number }>();
	/** Bumped by restart so late answers for the previous stream are dropped. */
	private stream = 0;
	private failure = false;
	private strict = false;
	private voiced = false;
	private speechMs = 0;
	private candidateSilenceMs = 0;
	private silenceMs = 0;
	private speechDetected = false;
	private finalized = false;
	private finalizedNow = false;

	constructor({
		sampleRate,
		classifier,
		minimumRms = DEFAULT_MINIMUM_RMS,
		silenceTimeoutMs = DEFAULT_VOICE_SILENCE_TIMEOUT_MS,
	}: {
		sampleRate: number;
		classifier: SpeechClassifier;
		minimumRms?: number;
		silenceTimeoutMs?: number;
	}) {
		if (!Number.isFinite(sampleRate) || sampleRate < 16_000)
			throw new RangeError("sampleRate must be at least 16 kHz");
		if (!Number.isFinite(silenceTimeoutMs) || silenceTimeoutMs <= 0)
			throw new RangeError("silenceTimeoutMs must be positive");
		this.classifier = classifier;
		this.minimumRms = minimumRms;
		this.silenceTimeoutMs = silenceTimeoutMs;
		this.resampler = createResampler(sampleRate);
	}

	/** The classifier failed; the detector cannot go on. */
	get failed() {
		return this.failure;
	}

	/** The latest classified window is voice (false in a pause or the trailing silence). */
	get hearing() {
		return this.voiced;
	}

	hasDetectedSpeech(): boolean {
		return this.speechDetected;
	}

	/** `strict` while our own reply is audible: it takes clearer, longer speech to start. */
	observe(frame: Float32Array, { strict = false } = {}): SpeechObservation {
		this.strict = strict;
		const rms = calculateRms(frame);
		for (const sample of this.resampler.push(frame)) {
			this.window[this.filled++] = sample;
			if (this.filled === SPEECH_WINDOW) {
				this.submit(this.window.slice());
				this.filled = 0;
			}
		}
		this.drain();
		const shouldFinalize = this.finalizedNow;
		this.finalizedNow = false;
		return { hasSpeech: this.speechDetected, shouldFinalize, rms };
	}

	/** Starts the next utterance with a fresh model stream. */
	restart() {
		this.stream++;
		this.results.clear();
		this.applied = this.sent;
		this.filled = 0;
		this.classifier.reset();
		this.voiced = false;
		this.speechMs = 0;
		this.candidateSilenceMs = 0;
		this.silenceMs = 0;
		this.speechDetected = false;
		this.finalized = false;
		this.finalizedNow = false;
	}

	private submit(window: Float32Array) {
		const id = this.sent++;
		const rms = calculateRms(window);
		const stream = this.stream;
		const answer = this.classifier.classify(window);
		if (typeof answer === "number") {
			this.results.set(id, { p: answer, rms });
			return;
		}
		answer.then(
			(p) => {
				if (stream === this.stream) this.results.set(id, { p, rms });
			},
			() => {
				if (stream === this.stream) this.failure = true;
			},
		);
	}

	private drain() {
		for (
			let result = this.results.get(this.applied);
			result;
			result = this.results.get(this.applied)
		) {
			this.results.delete(this.applied++);
			this.apply(result.p, result.rms);
		}
	}

	private apply(p: number, rms: number) {
		if (this.finalized) return;
		const on =
			this.strict && !this.speechDetected ? STRICT_SPEECH_ON : SPEECH_ON;
		// Voice starts only above the loudness floor (distant talk, a TV in another room is too
		// faint), then lasts while the model hears it: a word's fading end stays speech.
		if (p < SPEECH_OFF) this.voiced = false;
		else if (p >= on && rms >= this.minimumRms) this.voiced = true;
		if (!this.speechDetected) {
			if (this.voiced) {
				this.speechMs += WINDOW_MS;
				this.candidateSilenceMs = 0;
				const required = this.strict
					? STRICT_REQUIRED_SPEECH_MS
					: REQUIRED_SPEECH_MS;
				if (this.speechMs >= required) {
					this.speechDetected = true;
					this.silenceMs = 0;
				}
			} else if (this.speechMs > 0) {
				this.candidateSilenceMs += WINDOW_MS;
				if (this.candidateSilenceMs >= CANDIDATE_RESET_MS) {
					this.speechMs = 0;
					this.candidateSilenceMs = 0;
				}
			}
			return;
		}
		if (this.voiced) {
			this.silenceMs = 0;
			return;
		}
		this.silenceMs += WINDOW_MS;
		if (this.silenceMs >= this.silenceTimeoutMs) {
			this.finalized = true;
			this.finalizedNow = true;
		}
	}
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
