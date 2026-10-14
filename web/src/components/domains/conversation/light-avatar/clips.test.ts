import { expect, test } from "vitest";
import {
	compileMotion,
	sampleVariant,
	variantIndex,
	type Motion,
	type MotionData,
} from "./clips";
import { motionById, motions } from "./motions/index";

const base = (
	tracks: MotionData["variants"][number]["tracks"],
): MotionData => ({
	id: "test",
	label: "試験",
	group: "emotion",
	duration: 8,
	variants: [{ id: "test-a", label: "A", tracks }],
});

test("every registered motion starts and ends at rest, ending any spin on whole turns", () => {
	for (const motion of motions)
		for (const variant of motion.variants)
			for (const time of [0, motion.duration]) {
				const pose = sampleVariant(variant, time);
				for (const [channel, value] of Object.entries(pose)) {
					if (channel === "spin")
						expect(Math.abs(Math.sin(value / 2))).toBeLessThan(1e-6);
					else expect(Math.abs(value)).toBeLessThan(1e-6);
				}
			}
});

test("emotions and states each have at least two variants; every motion has a label", () => {
	for (const id of [
		"agreeing",
		"joyful",
		"listening",
		"curious",
		"surprised",
		"thinking",
		"speaking",
	])
		expect(motionById(id)!.variants.length).toBeGreaterThanOrEqual(2);
	for (const motion of motions) {
		expect(motion.label).not.toBe("");
		for (const variant of motion.variants) expect(variant.label).not.toBe("");
	}
});

test("the showpieces are present: a full spin when joyful, greeting and surprised", () => {
	const spins = (id: string) =>
		motionById(id)!.variants.some((variant) =>
			Array.from(
				{ length: 81 },
				(_, i) => sampleVariant(variant, i / 10).spin ?? 0,
			).some((spin) => Math.abs(spin) >= 2 * Math.PI - 1e-6),
		);
	expect(spins("joyful")).toBe(true);
	expect(spins("greeting")).toBe(true);
	expect(spins("surprised")).toBe(true);
	const joyful = motionById("joyful")!.variants[0]!;
	const jumps = Array.from(
		{ length: 41 },
		(_, i) => sampleVariant(joyful, i / 10)["body.py"] ?? 0,
	);
	expect(Math.max(...jumps)).toBeGreaterThan(0.3);
});

test("unsided arm keys author the right arm and mirror to the left", () => {
	const motion = compileMotion(
		base({
			arm_outer_02: [
				[0, 0, 0, 0],
				[4, 0.2, 0.3, 0.5],
				[8, 0, 0, 0],
			],
		}),
	);
	const pose = sampleVariant(motion.variants[0]!, 4);
	expect(pose["arm_outer_r_02.x"]).toBeCloseTo(0.2);
	expect(pose["arm_outer_r_02.z"]).toBeCloseTo(0.5);
	expect(pose["arm_outer_l_02.x"]).toBeCloseTo(0.2);
	expect(pose["arm_outer_l_02.y"]).toBeCloseTo(-0.3);
	expect(pose["arm_outer_l_02.z"]).toBeCloseTo(-0.5);
});

test("eye openness is authored as openness and composed as closure; blinks add closure", () => {
	const data = base({
		"eyes.open": [
			[0, 1],
			[4, 0.4],
			[8, 1],
		],
	});
	data.variants[0]!.blinks = [[6, 0.3]];
	const variant = compileMotion(data).variants[0]!;
	expect(sampleVariant(variant, 4)["eyes.close"]).toBeCloseTo(0.6);
	expect(sampleVariant(variant, 6.114)["eyes.close"]).toBeGreaterThan(0.9);
});

test("invalid motion data is rejected with the motion and track named", () => {
	expect(() =>
		compileMotion(
			base({
				wing: [
					[0, 0, 0, 0],
					[8, 0, 0, 0],
				],
			}),
		),
	).toThrow("test-a.wing");
	expect(() =>
		compileMotion(
			base({
				head: [
					[0, 0, 0, 0],
					[8, 0.2, 0, 0],
				],
			}),
		),
	).toThrow("静止姿勢");
	expect(() =>
		compileMotion(
			base({
				head: [
					[0, 0, 0, 0],
					[4, 4, 0, 0],
					[8, 0, 0, 0],
				],
			}),
		),
	).toThrow("範囲外");
	expect(() =>
		compileMotion(
			base({
				spin: [
					[0, 0],
					[8, Math.PI],
				],
			}),
		),
	).toThrow("静止姿勢");
	expect(() =>
		compileMotion(
			base({
				head: [
					[0, 0, 0, 0],
					[5, 0.1, 0, 0],
					[3, 0, 0, 0],
					[8, 0, 0, 0],
				],
			}),
		),
	).toThrow("昇順");
	expect(() => compileMotion({ ...base({}), duration: 6 })).toThrow("duration");
	expect(() => compileMotion({ ...base({}), group: "dance" as never })).toThrow(
		"group",
	);
});

test("variant choice never repeats on consecutive plays", () => {
	for (const count of [2, 3, 4]) {
		const motion = {
			variants: Array.from({ length: count }, (_, i) => ({ id: `v${i}` })),
		} as unknown as Motion;
		const picks = Array.from({ length: 200 }, (_, seed) =>
			variantIndex(motion, seed),
		);
		for (let i = 1; i < picks.length; i++)
			expect(picks[i]).not.toBe(picks[i - 1]);
		expect(new Set(picks).size).toBe(count);
	}
});
