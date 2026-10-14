import { expect, test } from "vitest";
import { sampleGazePose, sampleIdlePose } from "./idle";

const at = (time: number, channel: string, weight = 1) =>
	sampleIdlePose(time, weight)[channel] ?? 0;

test("idle floats visibly, sways the head, wings and flame, and keeps moving after minutes", () => {
	const lifts = Array.from({ length: 121 }, (_, i) => at(i / 10, "body.py"));
	expect(Math.max(...lifts) - Math.min(...lifts)).toBeGreaterThan(0.12);
	for (const lift of lifts) expect(Math.abs(lift)).toBeLessThanOrEqual(0.07);
	expect(
		Array.from({ length: 121 }, (_, i) => i / 10).some(
			(t) =>
				Math.abs(at(t, "head.y")) > 0.04 &&
				Math.abs(at(t, "arm_outer_l_03.z")) > 0.02 &&
				Math.abs(at(t, "tail_03.z")) > 0.03,
		),
	).toBe(true);
	expect(sampleIdlePose(122)).not.toEqual(sampleIdlePose(123));
});

test("the wings open and close in mirror", () => {
	for (const t of [1, 2.5, 7])
		expect(at(t, "arm_outer_l_02.z")).toBeCloseTo(-at(t, "arm_outer_r_02.z"));
});

test("idle blinks briefly, reopens, repeats, and fades blinks while a motion acts", () => {
	expect(at(2.72, "eyes.close")).toBeCloseTo(0.97);
	expect(at(2.6, "eyes.close")).toBe(0);
	expect(at(3, "eyes.close")).toBe(0);
	expect(at(19.72, "eyes.close")).toBeCloseTo(0.97);
	expect(at(2.72, "eyes.close", 0)).toBe(0);
});

test("the static display clock keeps idle at rest with open eyes", () => {
	for (const [channel, value] of Object.entries(sampleIdlePose(0)))
		expect(value).toBeCloseTo(channel === "light.energy" ? 0.05 : 0);
});

test("gaze turns the head partly back toward the viewer and moves the eyes in saccades", () => {
	expect(sampleGazePose(0, 0.6)["head.y"]!).toBeLessThan(
		sampleGazePose(0, 0)["head.y"]!,
	);
	const eyes = Array.from(
		{ length: 40 },
		(_, i) => sampleGazePose(i * 0.5, 0)["eyes.gx"]!,
	);
	expect(new Set(eyes.map((v) => v.toFixed(4))).size).toBeGreaterThan(5);
	for (const value of eyes) expect(Math.abs(value)).toBeLessThanOrEqual(0.018);
});
