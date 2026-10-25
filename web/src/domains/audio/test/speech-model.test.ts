// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { createSpeechModel, SPEECH_WINDOW } from "../controller/speech-model";

const model = readFileSync(
	fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url)),
);

async function probabilities(samples: Float32Array) {
	const speech = await createSpeechModel(ort, new Uint8Array(model));
	const out: number[] = [];
	for (let o = 0; o + SPEECH_WINDOW <= samples.length; o += SPEECH_WINDOW)
		out.push(await speech.classify(samples.subarray(o, o + SPEECH_WINDOW)));
	await speech.release();
	return out;
}

describe("Silero speech model", () => {
	it("hears no speech in silence, steady noise or keyboard clicks", async () => {
		let seed = 7;
		const random = () =>
			(seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const noise = Float32Array.from(
			{ length: 16000 * 2 },
			() => (random() * 2 - 1) * 0.02,
		);
		const clicks = new Float32Array(16000 * 3);
		for (
			let t = 800;
			t < clicks.length - 400;
			t += 1440 + Math.floor(random() * 1800)
		)
			for (let i = 0; i < 400; i++)
				clicks[t + i] = (random() * 2 - 1) * 0.3 * Math.exp(-i / 60);
		for (const samples of [new Float32Array(16000), noise, clicks]) {
			const result = await probabilities(samples);
			expect(result.every((p) => p >= 0 && p <= 1)).toBe(true);
			expect(result.filter((p) => p >= 0.5)).toEqual([]);
		}
	}, 30_000);

	it("rejects a window of the wrong length", async () => {
		const speech = await createSpeechModel(ort, new Uint8Array(model));
		await expect(speech.classify(new Float32Array(100))).rejects.toThrow(
			RangeError,
		);
		await speech.release();
	});
});
