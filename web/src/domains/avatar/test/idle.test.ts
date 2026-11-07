import { expect, test } from "vitest";
import { idleParameters } from "../live2d/idle";

test("the reduced-motion reference pose is still with no mouth or blink overrides", () => {
	expect(Object.values(idleParameters(0)).every((value) => value === 0)).toBe(
		true,
	);
	expect(idleParameters(1)).not.toHaveProperty("ParamMouthOpenY");
	expect(idleParameters(1)).not.toHaveProperty("ParamEyeLOpen");
	expect(idleParameters(1)).not.toHaveProperty("ParamLeg");
});

test("lively idle stays within each rig limit and moves continuously over a minute", () => {
	let previous = idleParameters(0);
	const limits = {
		ParamBreath: 0.8,
		ParamAngleX: 26,
		ParamAngleY: 14,
		ParamAngleZ: 20,
		ParamBodyAngleX: 2.5,
		ParamBodyAngleY: 1,
		ParamBodyAngleZ: 1.5,
		ParamEyeBallX: 0.25,
		ParamEyeBallY: 0.12,
	};
	for (let frame = 1; frame <= 60 * 24; frame++) {
		const current = idleParameters(frame / 24);
		for (const key of Object.keys(current) as Array<keyof typeof current>) {
			expect(Math.abs(current[key])).toBeLessThanOrEqual(limits[key]);
			expect(Math.abs(current[key] - previous[key])).toBeLessThan(1.5);
		}
		previous = current;
	}
});

test("head stays expressive while body movement remains small over ten seconds", () => {
	const poses = Array.from({ length: 240 }, (_, frame) =>
		idleParameters(frame / 24),
	);
	const span = (key: keyof ReturnType<typeof idleParameters>) =>
		Math.max(...poses.map((p) => p[key])) -
		Math.min(...poses.map((p) => p[key]));
	expect(span("ParamAngleX")).toBeGreaterThan(35);
	expect(span("ParamAngleY")).toBeGreaterThan(18);
	expect(span("ParamAngleZ")).toBeGreaterThan(24);
	expect(span("ParamBodyAngleX")).toBeLessThanOrEqual(5);
	expect(span("ParamBodyAngleY")).toBeLessThanOrEqual(2);
	expect(span("ParamBodyAngleZ")).toBeLessThanOrEqual(3);
});
