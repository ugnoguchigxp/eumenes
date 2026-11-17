import type { Model } from "../../../../../vendor/live2d/framework.js";

/** Blend from the last composed pose, before physics, blinking and speech. */
export function createPoseTransition(
	model: Pick<
		Model,
		| "getParameterCount"
		| "getParameterValueByIndex"
		| "setParameterValueByIndex"
	>,
) {
	const previous = new Float32Array(model.getParameterCount());
	const start = new Float32Array(previous.length);
	let initialized = false;
	let duration = 0;
	let elapsed = 0;
	return {
		apply(dt: number, fade?: number) {
			if (fade !== undefined && initialized) {
				start.set(previous);
				duration = fade;
				elapsed = 0;
			} else {
				elapsed += dt;
			}
			const weight =
				elapsed < duration
					? (1 - Math.cos((Math.PI * elapsed) / duration)) / 2
					: 1;
			for (let index = 0; index < previous.length; index++) {
				const target = model.getParameterValueByIndex(index);
				const value =
					weight === 1
						? target
						: start[index]! + (target - start[index]!) * weight;
				previous[index] = value;
				if (weight !== 1) model.setParameterValueByIndex(index, value);
			}
			initialized = true;
		},
		reset() {
			initialized = false;
			duration = 0;
			elapsed = 0;
		},
	};
}
