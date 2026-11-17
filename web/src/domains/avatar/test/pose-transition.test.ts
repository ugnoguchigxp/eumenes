import { expect, test } from "vitest";
import { createPoseTransition } from "../live2d/pose-transition";

test("pose transitions start at the last displayed values, even when interrupted", () => {
	const parameters = [10, -4];
	const transition = createPoseTransition({
		getParameterCount: () => parameters.length,
		getParameterValueByIndex: (index) => parameters[index]!,
		setParameterValueByIndex: (index, value) => {
			parameters[index] = value;
		},
	});
	const render = (target: number[], dt: number, fade?: number) => {
		parameters.splice(0, parameters.length, ...target);
		transition.apply(dt, fade);
		return parameters.map((value) => Number(value.toFixed(6)));
	};

	expect(render([10, -4], 0)).toEqual([10, -4]);
	expect(render([0, 5], 0.04, 0.5)).toEqual([10, -4]);
	expect(render([0, 5], 0.25)).toEqual([5, 0.5]);
	expect(render([-15, 10], 0.04, 0.5)).toEqual([5, 0.5]);
	expect(render([-15, 10], 0.25)).toEqual([-5, 5.25]);
	expect(render([-11, 8], 0.25)).toEqual([-11, 8]);
	transition.reset();
	expect(render([0, 0], 0, 0.5)).toEqual([0, 0]);
});
