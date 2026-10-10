import { describe, expect, it } from "vitest";
import {
	adaptiveThreshold,
	VoiceActivityDetector,
} from "../controller/voice-activity";

const quiet = new Float32Array(1600);
const speech = Float32Array.from({ length: 1600 }, (_, i) =>
	i % 2 ? 0.02 : -0.02,
);

describe("SAAA voice activity thresholds in Eumenes", () => {
	it("requires sustained speech and finalizes after silence", () => {
		const detector = new VoiceActivityDetector({
			sampleRate: 16000,
			silenceTimeoutMs: 700,
		});
		expect(detector.observe(speech).hasSpeech).toBe(false);
		expect(detector.observe(speech).hasSpeech).toBe(false);
		expect(detector.observe(speech).hasSpeech).toBe(true);
		for (let i = 0; i < 6; i++)
			expect(detector.observe(quiet).shouldFinalize).toBe(false);
		expect(detector.observe(quiet).shouldFinalize).toBe(true);
		expect(detector.observe(quiet).shouldFinalize).toBe(false);
	});

	it("rejects short noise and DC offset", () => {
		const detector = new VoiceActivityDetector({ sampleRate: 16000 });
		expect(detector.observe(speech).hasSpeech).toBe(false);
		detector.observe(quiet);
		detector.observe(quiet);
		expect(detector.observe(speech).hasSpeech).toBe(false);
		expect(detector.observe(new Float32Array(1600).fill(0.5)).hasSpeech).toBe(
			false,
		);
	});
});

const level = (rms: number) =>
	new Float32Array(1600).fill(0).map((_, i) => (i % 2 ? rms : -rms));

describe("adaptive speech threshold", () => {
	it("keeps the base threshold in a quiet room", () => {
		let state = { noiseFloor: 0, threshold: 0.008 };
		for (let i = 0; i < 200; i++)
			state = adaptiveThreshold(state.noiseFloor, 0.001, 0.008);
		expect(state.threshold).toBe(0.008);
	});

	it("rises to about three times steady noise", () => {
		let state = { noiseFloor: 0, threshold: 0.008 };
		for (let i = 0; i < 200; i++)
			state = adaptiveThreshold(state.noiseFloor, 0.01, 0.008);
		expect(state.threshold).toBeGreaterThan(0.029);
		expect(state.threshold).toBeLessThan(0.031);
	});

	it("does not treat a frame below the learned threshold as speech", () => {
		const detector = new VoiceActivityDetector({ sampleRate: 16000 });
		for (let i = 0; i < 100; i++) detector.observe(level(0.007));
		for (let i = 0; i < 5; i++) detector.observe(level(0.02));
		expect(detector.hasDetectedSpeech()).toBe(false);
	});

	it("does not raise the noise floor while speech is confirmed", () => {
		const detector = new VoiceActivityDetector({ sampleRate: 16000 });
		for (let i = 0; i < 3; i++) detector.observe(level(0.05));
		expect(detector.hasDetectedSpeech()).toBe(true);
		for (let i = 0; i < 100; i++) detector.observe(level(0.05));
		// A long voiced stretch must not have lifted the threshold above the speech level.
		expect(detector.observe(level(0.05)).shouldFinalize).toBe(false);
		for (let i = 0; i < 20; i++) detector.observe(level(0.001));
		expect(detector.observe(level(0.001)).shouldFinalize).toBe(false);
	});
});
