/**
 * Runs recordings through the voice detector exactly as the browser does (the Silero model and
 * the SpeechDetector rules) and prints the utterances it would send.
 *
 *   bun scripts/vad-eval.ts [--strict] <file.wav>...
 *
 * WAV: PCM 16-bit, mono or stereo (the first channel is used), 16 kHz or higher. For the
 * acceptance in spec/ml-voice-activity-detection-design-2026-10-25.md §6.
 */
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { SpeechDetector } from "../web/src/domains/audio/controller/speech-detector";
import { createSpeechModel } from "../web/src/domains/audio/controller/speech-model";

const FRAME = 2048;

function readWav(path: string) {
	const bytes = readFileSync(path);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		bytes.toString("ascii", 0, 4) !== "RIFF" ||
		bytes.toString("ascii", 8, 12) !== "WAVE"
	)
		throw new Error(`${path}: not a WAV file`);
	let rate = 0,
		channels = 0;
	for (let offset = 12; offset + 8 <= bytes.length;) {
		const tag = bytes.toString("ascii", offset, offset + 4);
		const length = view.getUint32(offset + 4, true);
		const start = offset + 8;
		if (tag === "fmt ") {
			if (
				view.getUint16(start, true) !== 1 ||
				view.getUint16(start + 14, true) !== 16
			)
				throw new Error(`${path}: only 16-bit PCM is supported`);
			channels = view.getUint16(start + 2, true);
			rate = view.getUint32(start + 4, true);
		}
		if (tag === "data") {
			const count = Math.floor(length / 2 / channels);
			const samples = new Float32Array(count);
			for (let i = 0; i < count; i++)
				samples[i] = view.getInt16(start + i * channels * 2, true) / 32768;
			return { rate, samples };
		}
		offset = start + length + (length % 2);
	}
	throw new Error(`${path}: no data chunk`);
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const files = args.filter((a) => a !== "--strict");
if (!files.length) {
	console.error("usage: bun scripts/vad-eval.ts [--strict] <file.wav>...");
	process.exit(2);
}
ort.env.wasm.numThreads = 1;
const modelBytes = new Uint8Array(
	readFileSync(
		new URL("../web/src/domains/audio/models/silero_vad.onnx", import.meta.url),
	),
);
for (const file of files) {
	const { rate, samples } = readWav(file);
	const model = await createSpeechModel(ort, modelBytes);
	const detector = new SpeechDetector({
		sampleRate: rate,
		classifier: { classify: model.classify, reset: model.reset, close() {} },
	});
	const utterances: string[] = [];
	let start: number | null = null;
	for (let offset = 0; offset < samples.length; offset += FRAME) {
		const frame = samples.subarray(offset, offset + FRAME);
		// Settle each frame's windows before the next, as a fast browser worker would.
		let { hasSpeech, shouldFinalize } = detector.observe(frame, { strict });
		for (let i = 0; i < 4; i++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			const later = detector.observe(new Float32Array(0), { strict });
			hasSpeech ||= later.hasSpeech;
			shouldFinalize ||= later.shouldFinalize;
		}
		const seconds = (offset + frame.length) / rate;
		if (hasSpeech && start === null) start = seconds;
		if (shouldFinalize && start !== null) {
			utterances.push(`${start.toFixed(2)}s→${seconds.toFixed(2)}s`);
			start = null;
			detector.restart();
		}
	}
	if (start !== null) utterances.push(`${start.toFixed(2)}s→(end)`);
	await model.release();
	console.log(
		`${file}: ${utterances.length} utterance(s)${utterances.length ? ` ${utterances.join(" ")}` : ""}`,
	);
}
