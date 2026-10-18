import type { SpatialModels } from "../contracts";
import { createParticleModel, type ParticleData } from "./particles";

import { particleModelIds } from "./catalog";
export { particleModelIds } from "./catalog";
const descriptors = import.meta.glob<{
	id: string;
	stride: number;
	componentsPerPoint?: number;
	pointCount: number;
	normalizationRadius: number;
}>("./assets/*.json", { eager: true, import: "default" });
const urls = import.meta.glob<string>("./assets/*.bin", {
	eager: true,
	query: "?url",
	import: "default",
});
let pending: Promise<SpatialModels> | undefined;

export function decodeParticles(
	binary: ArrayBuffer,
	descriptor: {
		stride: number;
		componentsPerPoint?: number;
		pointCount: number;
		normalizationRadius: number;
	},
) {
	if (
		(descriptor.componentsPerPoint ?? descriptor.stride) !== 8 ||
		binary.byteLength !== descriptor.pointCount * 32 ||
		!Number.isFinite(descriptor.normalizationRadius) ||
		descriptor.normalizationRadius <= 0
	)
		throw new Error("invalid_particle_model");
	const points = new Float32Array(binary);
	if (points.some((value) => !Number.isFinite(value)))
		throw new Error("invalid_particle_coordinate");
	return points;
}

/** Assets are bundled locally, not downloaded from Sites or a provider. Retry does not retain failures. */
export function loadSpatialModels(): Promise<SpatialModels> {
	pending ??= Promise.all(
		particleModelIds.map(async (id, index) => {
			const descriptor = descriptors[`./assets/${id}.json`]!;
			const response = await fetch(urls[`./assets/${id}.bin`]!);
			if (!response.ok) throw new Error("particle_model_unavailable");
			const data: ParticleData = {
				id,
				index,
				radius: descriptor.normalizationRadius,
				points: decodeParticles(await response.arrayBuffer(), descriptor),
			};
			return [id, () => createParticleModel(data)] as const;
		}),
	)
		.then((entries) => Object.freeze(Object.fromEntries(entries)))
		.catch((error: unknown) => {
			pending = undefined;
			throw error;
		});
	return pending;
}
