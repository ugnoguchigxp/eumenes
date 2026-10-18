import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { evaluateParticle, type AnimationInput } from "./evaluator";
import { particleModelIds } from "./catalog";
import { healthColors } from "../options";
import { scatterPositionGLSL } from "./diffusion";

test("all roles keep fixed geometry/size, health priority and at most ten percent activity uplift", () => {
	for (const model of particleModelIds) {
		const bytes = readFileSync(
				`web/src/domains/background/models/assets/${model}.bin`,
			),
			data = new Float32Array(
				bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				),
			),
			before = data.slice();
		for (const health of Object.keys(
			healthColors,
		) as (keyof typeof healthColors)[])
			for (const activity of ["idle", "starting", "working"] as const)
				for (const t of [0, 0.25, 12, 1000000]) {
					const input: AnimationInput = {
						model,
						health,
						activity,
						stale: false,
						reducedMotion: false,
						utilization: 1,
					};
					for (let i = 0; i < data.length / 8; i += 31) {
						const sample = evaluateParticle(data, i, t, input);
						expect(sample.color).toBe(healthColors[health]);
						expect(sample.size).toBe(data[i * 8 + 6]);
						expect(sample.uplift).toBeGreaterThanOrEqual(0);
						expect(sample.uplift).toBeLessThanOrEqual(0.1);
						expect(sample.intensity).toBeLessThanOrEqual(
							sample.baseIntensity * 1.1 + 1e-10,
						);
						for (const stop of [
							{ stale: true },
							{ reducedMotion: true },
							...(["unknown", "disconnected"].includes(health) ? [{}] : []),
						])
							expect(
								evaluateParticle(data, i, 0, { ...input, ...stop }),
							).toEqual(evaluateParticle(data, i, 100, { ...input, ...stop }));
					}
				}
		expect(data).toEqual(before);
	}
});
test("actual GLSL leaves 40/60 percent unchanged and uses six/four seed deciles", () => {
	const scalar = scatterPositionGLSL.split("vec3 scatterPosition")[0]!;
	const body = scalar
		.replace(/float (\w+)\(float seed, float (\w+)\)/g, "function $1(seed,$2)")
		.replace(/\bfloat\b/g, "let");
	const fn = new Function(
		"seed",
		"coreFraction",
		"floor",
		"min",
		"clamp",
		"abs",
		"uCoreStart",
		"uCoreEnd",
		body + ";return scatterGradient(seed,coreFraction);",
	);

	for (const core of [0.4, 0.6])
		for (let i = 0; i < 1000; i++) {
			const seed = i / 1000,
				weight = fn(
					seed,
					core,
					Math.floor,
					Math.min,
					(v: number, a: number, b: number) => Math.max(a, Math.min(b, v)),
					Math.abs,
					0.4,
					0.6,
				);
			if (seed < core) expect(weight).toBe(0);
			else
				expect(weight).toBeCloseTo(
					(Math.min(9, Math.floor(seed * 10)) - core * 10 + 1) /
						(10 - core * 10),
					12,
				);
		}
});
