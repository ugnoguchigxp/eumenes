import { describe, expect, it } from "vitest";
import { VoiceActivityDetector } from "../controller/voice-activity";

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
