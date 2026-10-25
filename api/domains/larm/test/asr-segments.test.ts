import { expect, test } from "bun:test";
import { asrWavSegments } from "../service/asr-wav";
import { transcribeWav } from "../service/transcription";
import type { Provider } from "../service/profiles";

function pcm(seconds: number, rate = 16000, channels = 1) {
	const bytes = new Uint8Array(44 + seconds * rate * channels * 2);
	const h = new DataView(bytes.buffer);
	for (const [offset, tag] of [
		[0, "RIFF"],
		[8, "WAVE"],
		[12, "fmt "],
		[36, "data"],
	] as const)
		bytes.set(new TextEncoder().encode(tag), offset);
	h.setUint32(4, bytes.length - 8, true);
	h.setUint32(16, 16, true);
	h.setUint16(20, 1, true);
	h.setUint16(22, channels, true);
	h.setUint32(24, rate, true);
	h.setUint32(28, rate * channels * 2, true);
	h.setUint16(32, channels * 2, true);
	h.setUint16(34, 16, true);
	h.setUint32(40, bytes.length - 44, true);
	for (let i = 44; i < bytes.length; i++) bytes[i] = i % 251;
	return bytes;
}
const provider: Provider = {
	name: "asr",
	model: "fixture-asr",
	token: "fixture",
	baseUrl: "http://127.0.0.1:9810",
	protocol: "openai.audio-transcriptions.v1",
};

test("a quiet pause before the limit is used without dropping or repeating samples", () => {
	const wav = pcm(13);
	wav.fill(0, 44 + 32000 * 10.7, 44 + 32000 * 11);
	// A later 60 ms phoneme gap is too short to be a safe cut.
	wav.fill(0, 44 + 32000 * 11.5, 44 + 32000 * 11.56);
	const parts = asrWavSegments(wav);
	expect(parts).toHaveLength(2);
	const seconds = (parts[0]!.length - 44) / 32000;
	expect(seconds).toBeGreaterThan(10.7);
	expect(seconds).toBeLessThanOrEqual(11);
	expect(Buffer.concat(parts.map((part) => part.subarray(44)))).toEqual(
		Buffer.from(wav.subarray(44)),
	);
});

test.each([
	[16000, 1],
	[44100, 2],
])(
	"PCM at %i Hz and %i channels keeps every sample across the 12-second envelope",
	(rate, channels) => {
		const wav = pcm(25, rate, channels);
		const parts = asrWavSegments(wav);
		expect(parts).toHaveLength(3);
		const audio = Buffer.concat(parts.map((part) => part.subarray(44)));
		expect(audio).toEqual(Buffer.from(wav.subarray(44)));
		for (const part of parts) {
			const h = new DataView(part.buffer);
			expect(h.getUint32(4, true)).toBe(part.length - 8);
			expect(h.getUint32(40, true)).toBe(part.length - 44);
			expect((part.length - 44) / (rate * channels * 2)).toBeLessThanOrEqual(
				12,
			);
			expect(part.subarray(8, 40)).toEqual(wav.subarray(8, 40));
		}
	},
);

test("a short request is unchanged and a byte-offset view is split without reading its prefix", () => {
	const short = pcm(12);
	expect(asrWavSegments(short)).toEqual([short]);
	const wav = pcm(13);
	const backing = new Uint8Array(wav.length + 7);
	backing.set(wav, 7);
	expect(asrWavSegments(backing.subarray(7))).toEqual(asrWavSegments(wav));
	const unsupported = wav.slice();
	new DataView(unsupported.buffer).setUint16(20, 6, true);
	expect(asrWavSegments(unsupported)).toEqual([unsupported]);
});

test("WAV metadata before and after the data chunk survives segmentation", () => {
	const original = pcm(13);
	const wav = new Uint8Array(original.length + 20);
	wav.set(original.subarray(0, 36));
	wav.set(new TextEncoder().encode("JUNK"), 36);
	new DataView(wav.buffer).setUint32(40, 4, true);
	wav.set([1, 2, 3, 4], 44);
	wav.set(original.subarray(36), 48);
	wav.set(new TextEncoder().encode("LIST"), wav.length - 8);
	new DataView(wav.buffer).setUint32(4, wav.length - 8, true);
	const parts = asrWavSegments(wav);
	expect(parts).toHaveLength(2);
	for (const part of parts) {
		expect(part.subarray(36, 48)).toEqual(wav.subarray(36, 48));
		expect(part.subarray(-8)).toEqual(wav.subarray(-8));
	}
	expect(Buffer.concat(parts.map((part) => part.subarray(56, -8)))).toEqual(
		Buffer.from(original.subarray(44)),
	);
});

test("one long utterance sends bounded requests in order and returns one transcript", async () => {
	const lengths: number[] = [];
	const text = await transcribeWav(
		provider,
		pcm(25),
		async (_p, operation, init) => {
			expect(operation).toBe("audio/transcriptions");
			const form = init.body as FormData;
			expect(form.get("model")).toBe(provider.model);
			const audio = new Uint8Array(
				await (form.get("file") as Blob).arrayBuffer(),
			);
			lengths.push(audio.length);
			return Response.json({ text: `区間${lengths.length}` });
		},
		new AbortController().signal,
		"fixture-connection",
	);
	expect(lengths).toEqual([384044, 384044, 32044]);
	expect(text).toBe("区間1\n区間2\n区間3");
});

test.each(["failure", "cancel"])(
	"a %s after the first part yields no partial transcript or later request",
	async (mode) => {
		let calls = 0;
		const controller = new AbortController();
		const pending = transcribeWav(
			provider,
			pcm(25),
			async () => {
				calls++;
				if (mode === "cancel") controller.abort();
				if (calls === 2) throw new Error("larm_inference_503");
				return Response.json({ text: "途中" });
			},
			controller.signal,
			"fixture-connection",
		);
		await expect(pending).rejects.toThrow();
		expect(calls).toBe(mode === "cancel" ? 1 : 2);
	},
);

test("the transcript capacity applies to the complete utterance, not each part", async () => {
	await expect(
		transcribeWav(
			provider,
			pcm(25),
			async () => Response.json({ text: "あ".repeat(2048) }),
			new AbortController().signal,
			"fixture-connection",
		),
	).rejects.toThrow("larm_invalid_contract");
});
