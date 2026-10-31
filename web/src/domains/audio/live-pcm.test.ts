import { expect, test } from "vitest";
import { pcm16, resampler } from "./live-pcm";
test("PCM is little endian and clips to the signed 16-bit range", () => {
	expect([...pcm16(new Float32Array([-2, -1, 0, 1, 2]))]).toEqual([
		0, 128, 0, 128, 0, 0, 255, 127, 255, 127,
	]);
});
test("sample conversion keeps the same phase and data across arbitrary microphone frames", () => {
	const samples = Float32Array.from({ length: 10000 }, (_, i) =>
		Math.sin(i / 13),
	);
	const single = resampler(44100)(samples);
	const convert = resampler(44100);
	const frames: Uint8Array[] = [];
	for (let at = 0; at < samples.length; at += 333)
		frames.push(convert(samples.slice(at, at + 333)));
	const joined = new Uint8Array(frames.reduce((n, b) => n + b.length, 0));
	let at = 0;
	for (const frame of frames) {
		joined.set(frame, at);
		at += frame.length;
	}
	expect(joined.length).toBe(single.length);
	const a = new DataView(joined.buffer),
		b = new DataView(single.buffer);
	for (let i = 0; i < joined.length; i += 2)
		expect(
			Math.abs(a.getInt16(i, true) - b.getInt16(i, true)),
		).toBeLessThanOrEqual(1);
});
