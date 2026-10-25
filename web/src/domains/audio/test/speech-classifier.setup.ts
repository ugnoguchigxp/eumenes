import { vi } from "vitest";

/**
 * Tests drive the microphone with synthetic tones, so the learned model (a Web Worker with
 * WebAssembly) is replaced by a volume stand-in that answers at once. The model itself is
 * tested in speech-model.test.ts.
 */
vi.mock("../controller/speech-classifier", () => ({
	createSpeechClassifier: vi.fn(async () => ({
		classify(window: Float32Array) {
			let sum = 0;
			for (const sample of window) sum += sample * sample;
			return Math.sqrt(sum / window.length) >= 0.008 ? 0.9 : 0.05;
		},
		reset() {},
		close() {},
	})),
}));
