import { expect, test } from "vitest";
import { createBlink, createFace } from "../live2d/face";

test("feelings that share a gesture can keep different facial expressions", () => {
	const warmth = createFace(() => 1)(1, 1, "agreeing", 0, 1, "warmth");
	const wry = createFace(() => 1)(1, 1, "agreeing", 0, 1, "wry");
	const sadness = createFace(() => 1)(1, 1, "downcast", 0, 1, "sadness");
	const apology = createFace(() => 1)(1, 1, "downcast", 0, 1, "apologetic");
	expect(warmth.ParamBrowLY).toBe(warmth.ParamBrowRY);
	expect(wry.ParamBrowLY).toBeGreaterThan(wry.ParamBrowRY);
	expect(apology.ParamBrowLY).toBeGreaterThan(sadness.ParamBrowLY);
	expect(apology.ParamMouthOpenY).toBe(0);
});

test("blinks use bounded random intervals and reopen without a timer", () => {
	const blink = createBlink(() => 0);
	expect(blink(2.9)).toBe(0);
	expect(blink(3.08)).toBeCloseTo(1);
	expect(blink(3.2)).toBe(0);
	expect(blink(6.28)).toBeCloseTo(1);
	expect(blink(100)).toBe(0);
	expect(blink(0)).toBe(0);
});

test("judged expressions interpolate and never override speech opening or blinking", () => {
	const face = createFace(() => 0);
	const first = face(0.04, 0.04, "joyful", 0.4);
	expect(first.ParamEyeLSmile).toBeGreaterThan(0);
	expect(first.ParamEyeLSmile).toBeLessThan(0.9);
	const joy = face(1, 1, "joyful", 0.4);
	expect(joy.ParamEyeLSmile).toBeGreaterThan(0.85);
	expect(joy.ParamMouthOpenY).toBe(0.4);
	const blink = face(3.08, 0.1, "joyful", 0.4);
	expect(blink.ParamEyeLOpen).toBeCloseTo(0);
	expect(blink.ParamMouthOpenY).toBe(0.4);
	const stopped = face(3.3, 0.1, "surprised", 0);
	expect(stopped.ParamEyeLOpen).toBeGreaterThan(0);
	expect(stopped.ParamMouthOpenY).toBe(0);
});

test("intensity blends with neutral and malformed amplitudes cannot leave a mouth open", () => {
	const full = createFace(() => 0)(1, 1, "joyful", 1, 1);
	const half = createFace(() => 0)(1, 1, "joyful", 1, 0.5);
	const zero = createFace(() => 0)(1, 1, "joyful", NaN, 0);
	expect(half.ParamEyeLSmile).toBeCloseTo(full.ParamEyeLSmile / 2);
	expect(zero.ParamEyeLSmile).toBe(0);
	expect(zero.ParamMouthOpenY).toBe(0);
	expect(full.ParamMouthOpenY).toBe(0.7);
});

test.each(["thinking", "distant"] as const)(
	"%s has its own face without changing the speech opening",
	(motion) => {
		const face = createFace(() => 0)(1, 1, motion, 0.4);
		expect(face.ParamBrowLY).not.toBe(0);
		expect(face.ParamMouthForm).toBeLessThan(0);
		expect(face.ParamMouthOpenY).toBe(0.4);
	},
);

test("neutral softly changes its face without an emotion cue or a speaking mouth", () => {
	const face = createFace(() => 0);
	const still = face(0, 0, "neutral", 0);
	expect(still.ParamEyeLSmile).toBe(0);
	expect(still.ParamMouthForm).toBe(0);
	let maxSmile = 0;
	let previous = still.ParamEyeLSmile;
	for (let frame = 1; frame <= 12 * 24; frame++) {
		const values = face(frame / 24, 1 / 24, "neutral", 0);
		maxSmile = Math.max(maxSmile, values.ParamEyeLSmile);
		expect(values.ParamEyeLSmile).toBeLessThanOrEqual(0.4);
		expect(Math.abs(values.ParamEyeLSmile - previous)).toBeLessThan(0.03);
		expect(values.ParamMouthOpenY).toBe(0);
		previous = values.ParamEyeLSmile;
	}
	expect(maxSmile).toBeGreaterThan(0.35);
	const emotion = face(12.5, 1, "downcast", 0.45);
	expect(emotion.ParamMouthForm).toBeLessThan(-0.45);
	expect(emotion.ParamEyeLSmile).toBeLessThan(0.01);
	expect(emotion.ParamMouthOpenY).toBe(0.45);
	const zero = createFace(() => 0)(4, 1, "neutral", 0, 0);
	expect(zero.ParamEyeLSmile).toBe(0);
	expect(zero.ParamMouthForm).toBe(0);
});
