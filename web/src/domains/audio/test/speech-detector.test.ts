import { describe, expect, it } from "vitest";
import { SpeechDetector } from "../controller/speech-detector";
import type { SpeechClassifier } from "../controller/speech-classifier";

/** One 16 kHz frame of three 32 ms windows at a level that passes the loudness floor. */
const FRAME = 1536;
const loud = () =>
	new Float32Array(FRAME).fill(0).map((_, i) => (i % 16 < 8 ? 0.05 : -0.05));
const faint = () =>
	new Float32Array(FRAME).fill(0).map((_, i) => (i % 16 < 8 ? 0.002 : -0.002));

/** Answers each window with the next scripted probability (the last one repeats). */
function scripted(probabilities: number[]) {
	let next = 0;
	const resets: number[] = [];
	const classifier: SpeechClassifier = {
		classify: () => probabilities[Math.min(next++, probabilities.length - 1)]!,
		reset: () => resets.push(next),
		close() {},
	};
	return { classifier, resets };
}

const detector = (classifier: SpeechClassifier, silenceTimeoutMs = 320) =>
	new SpeechDetector({ sampleRate: 16000, classifier, silenceTimeoutMs });

describe("speech detector", () => {
	it("confirms speech after 200 ms of voiced windows and finalizes after the silence", () => {
		const probabilities = [...Array(7).fill(0.9), ...Array(20).fill(0.1)];
		const d = detector(scripted(probabilities).classifier);
		expect(d.observe(loud()).hasSpeech).toBe(false); // 96 ms
		expect(d.observe(loud()).hasSpeech).toBe(false); // 192 ms
		expect(d.observe(loud()).hasSpeech).toBe(true); // 7th window: 224 ms
		const finals = Array.from(
			{ length: 6 },
			() => d.observe(loud()).shouldFinalize,
		);
		// Two silent windows already ended the third frame; 320 ms (10 windows) completes in the
		// third frame after it, and is reported once.
		expect(finals).toEqual([false, false, true, false, false, false]);
	});

	it("keeps the state between the on and off probabilities", () => {
		const d = detector(scripted([0.9, 0.9, 0.4]).classifier);
		for (let i = 0; i < 3; i++) d.observe(loud());
		expect(d.hasDetectedSpeech()).toBe(true);
	});

	it("ignores voice-like windows below the loudness floor", () => {
		const d = detector(scripted([0.95]).classifier);
		for (let i = 0; i < 5; i++) d.observe(faint());
		expect(d.hasDetectedSpeech()).toBe(false);
	});

	it("starts the count again after a 200 ms pause before speech is confirmed", () => {
		const probabilities = [
			0.9,
			0.9,
			0.9,
			0.9,
			0.9,
			...Array(7).fill(0.1),
			0.9,
			0.9,
			0.9,
		];
		const d = detector(scripted(probabilities).classifier);
		for (let i = 0; i < 5; i++) d.observe(loud());
		expect(d.hasDetectedSpeech()).toBe(false);
	});

	it("takes clearer, longer speech while our own reply is audible", () => {
		const unclear = detector(scripted([0.7]).classifier);
		for (let i = 0; i < 6; i++) unclear.observe(loud(), { strict: true });
		expect(unclear.hasDetectedSpeech()).toBe(false);
		const clear = detector(scripted([0.9]).classifier);
		for (let i = 0; i < 4; i++) clear.observe(loud(), { strict: true });
		expect(clear.hasDetectedSpeech()).toBe(false); // 384 ms
		clear.observe(loud(), { strict: true });
		expect(clear.hasDetectedSpeech()).toBe(true);
	});

	it("applies late answers in order on a later frame and drops those of a restarted stream", async () => {
		const answers: Array<(p: number) => void> = [];
		const classifier: SpeechClassifier = {
			classify: () => new Promise<number>((resolve) => answers.push(resolve)),
			reset() {},
			close() {},
		};
		const d = detector(classifier);
		for (let i = 0; i < 3; i++) d.observe(loud());
		// Answered out of order: nothing applies until the first window's answer arrives.
		for (const resolve of answers.slice(1).reverse()) resolve(0.9);
		await Promise.resolve();
		expect(d.observe(new Float32Array(0)).hasSpeech).toBe(false);
		answers[0]!(0.9);
		await Promise.resolve();
		expect(d.observe(new Float32Array(0)).hasSpeech).toBe(true);
		d.restart();
		const before = answers.length;
		d.observe(loud());
		for (const resolve of answers.slice(before)) resolve(0.9);
		await Promise.resolve();
		expect(d.observe(new Float32Array(0)).hasSpeech).toBe(false);
	});

	it("restarts the model stream for each utterance", () => {
		const { classifier, resets } = scripted([0.9]);
		const d = detector(classifier);
		d.restart();
		expect(resets).toHaveLength(1);
	});

	it("reports a failed classifier", async () => {
		const d = detector({
			classify: () => Promise.reject(new Error("worker_gone")),
			reset() {},
			close() {},
		});
		d.observe(loud());
		await Promise.resolve();
		await Promise.resolve();
		expect(d.failed).toBe(true);
	});
});
