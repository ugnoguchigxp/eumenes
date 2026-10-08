import { expect, test } from "vitest";
import { samplePerformancePose } from "./performance";

test("speech adds nods and hand movements to a neutral fallback for the full audio duration", () => {
	const idle = samplePerformancePose("neutral", 1.5, false);
	const speech = samplePerformancePose("neutral", 1.5, true);
	expect(speech.hx).toBeGreaterThan(idle.hx);
	expect(speech.left).toBeGreaterThan(idle.left);
	expect(samplePerformancePose("neutral", 33.5, true)).toEqual(speech);
	expect(samplePerformancePose("neutral", 32.8, true)).not.toEqual(speech);
});

test("Laya emotions remain distinct while the avatar talks and repeat during long speech", () => {
	const neutral = samplePerformancePose("neutral", 1.1, true);
	const happy = samplePerformancePose("joyful", 1.1, true);
	const sad = samplePerformancePose("downcast", 3, true);
	expect(happy.lift).toBeGreaterThan(neutral.lift);
	expect(happy.open).toBeLessThan(neutral.open);
	expect(sad.lift).toBeLessThan(0);
	expect(sad.hx).toBeGreaterThan(0.1);
	expect(samplePerformancePose("joyful", 17.1, true).lift).toBeCloseTo(
		happy.lift,
	);
	expect(samplePerformancePose("joyful", 1.1, false).left).not.toBe(happy.left);
});

test("loop boundaries return near neutral before starting the next speaking phrase", () => {
	const before = samplePerformancePose("joyful", 7.999, true);
	const after = samplePerformancePose("joyful", 8.001, true);
	for (const key of Object.keys(before) as Array<keyof typeof before>)
		expect(Math.abs(before[key] - after[key])).toBeLessThan(0.001);
});
