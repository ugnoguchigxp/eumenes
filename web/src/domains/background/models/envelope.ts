import type { ParticleData } from "./particles";

/** Enlarge the existing shape, without adding points or changing their light. */
export const PARTICLE_MODEL_SCALE = 1.35;
const TAU = Math.PI * 2;
function diffusionCurve(seed: number) {
	const layer = Math.max(0, Math.min(1, seed)) * 10;
	const band = Math.floor(layer),
		t = layer - band;
	return band + t * t * (3 - 2 * t);
}

/** Rotation-invariant envelope of the actual GPU-expanded point data. Cached per shape setting. */
export function createParticleEnvelope(data: ParticleData) {
	let previousScatter = -1,
		previousCore = -1;
	const bounds = { radius: 1, depth: 1 };
	return (scatterPercent: number, corePercent: number) => {
		if (previousScatter === scatterPercent && previousCore === corePercent)
			return bounds;
		previousScatter = scatterPercent;
		previousCore = corePercent;
		const start = diffusionCurve(corePercent / 100);
		bounds.radius = bounds.depth = 0;
		for (let i = 0; i < data.points.length; i += 8) {
			const x = data.points[i]!,
				y = data.points[i + 1]!,
				z = data.points[i + 2]!;
			const phase = data.points[i + 3]!,
				group = data.points[i + 4]!,
				seed = data.points[i + 5]!;
			const gradient = Math.max(
				0,
				Math.min(1, (diffusionCurve(seed) - start) / (10 - start)),
			);
			const amount = (scatterPercent / 100) * gradient;
			const along = 0.5 + 0.5 * Math.cos(phase * TAU + group * 0.25);
			const release =
				0.22 + 0.78 * (0.55 * Math.max(0, Math.min(1, seed)) + 0.45 * along);
			const radius =
				(Math.hypot(x, y) / data.radius) * (data.index === 0 ? 1.028 : 1);
			const depth =
				(Math.abs(z) + (data.index === 0 ? 0.041 : 0)) / data.radius;
			bounds.radius = Math.max(
				bounds.radius,
				radius * (1 + 4.6 * amount * release) * PARTICLE_MODEL_SCALE,
			);
			bounds.depth = Math.max(
				bounds.depth,
				depth * (1 + 0.75 * amount * release) * PARTICLE_MODEL_SCALE,
			);
		}
		return bounds;
	};
}
