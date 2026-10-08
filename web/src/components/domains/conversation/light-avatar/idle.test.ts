import { expect, test } from "vitest";
import { sampleIdlePose, sampleOccasionalSway } from "./idle";

test("idle floats visibly, moves head and wings, and keeps moving after minutes", () => {
	const samples = Array.from({ length: 121 }, (_, i) => sampleIdlePose(i / 10));
	expect(
		Math.max(...samples.map((p) => p.lift)) -
			Math.min(...samples.map((p) => p.lift)),
	).toBeGreaterThan(0.12);
	expect(
		samples.some((p) => Math.abs(p.hy) > 0.04 && Math.abs(p.left) > 0.02),
	).toBe(true);
	expect(sampleIdlePose(122)).not.toEqual(sampleIdlePose(123));
	for (const pose of samples) {
		expect(Math.abs(pose.lift)).toBeLessThanOrEqual(0.07);
		expect(Math.abs(pose.hy)).toBeLessThan(0.08);
	}
});

test("occasional body sways leave long quiet gaps and enter and leave smoothly", () => {
	const samples = Array.from({ length: 1200 }, (_, i) =>
		sampleOccasionalSway(i / 10),
	);
	expect(
		samples.filter((value) => Math.abs(value) > 0.001).length / samples.length,
	).toBeLessThan(0.2);
	expect(sampleOccasionalSway(9.6)).toBeGreaterThan(0.6);
	expect(sampleOccasionalSway(11.2)).toBeLessThan(-0.6);
	expect(sampleOccasionalSway(20)).toBe(0);
	expect(sampleOccasionalSway(37.6)).toBeLessThan(-0.6);
	for (const edge of [8, 12.8, 36, 40.8]) {
		expect(Math.abs(sampleOccasionalSway(edge - 0.001))).toBeLessThan(0.000001);
		expect(Math.abs(sampleOccasionalSway(edge + 0.001))).toBeLessThan(0.000001);
	}
	expect(sampleOccasionalSway(129.6)).toBeCloseTo(sampleOccasionalSway(9.6));
	const base = sampleIdlePose(9.6, 0),
		mixed = sampleIdlePose(9.6, 1);
	expect(mixed.bz - base.bz).toBeGreaterThan(0.07);
	expect(mixed.lift).toBe(base.lift);
});

test("idle blinks briefly, reopens its eyes, and repeats beyond the first cycle", () => {
	expect(sampleIdlePose(2.72).open).toBeCloseTo(0.03);
	expect(sampleIdlePose(2.6).open).toBe(1);
	expect(sampleIdlePose(3).open).toBe(1);
	expect(sampleIdlePose(19.72).open).toBeCloseTo(0.03);
});

test("the static display clock keeps idle neutral with open eyes", () => {
	const pose = sampleIdlePose(0);
	for (const [key, value] of Object.entries(pose)) {
		expect(value).toBeCloseTo(key === "open" ? 1 : 0);
	}
});
