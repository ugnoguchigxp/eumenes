import { expect, test } from "vitest";
import { createBlink, createFace } from "../live2d/face";

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
