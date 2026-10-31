import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { evaluateParticle, type AnimationInput } from "./evaluator";
import { particleModelIds } from "./catalog";
import { healthColors, standbyColor } from "../options";
import { statusColor } from "../status";
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
						for (const channel of sample.color) {
							expect(channel).toBeGreaterThanOrEqual(0);
							expect(channel).toBeLessThanOrEqual(1);
						}
						{
							const hex = parseInt(statusColor(input).slice(1), 16);
							expect(sample.color).toEqual([
								((hex >> 16) & 255) / 255,
								((hex >> 8) & 255) / 255,
								(hex & 255) / 255,
							]);
						}
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

function cpuColors() {
	const bytes = readFileSync(
		"web/src/domains/background/models/assets/cpu.bin",
	);
	return new Float32Array(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	);
}
const healthy: AnimationInput = {
	model: "cpu",
	health: "healthy",
	activity: "idle",
	stale: false,
	reducedMotion: false,
};

test("status hues remain distinct at every time and load, with waiting white and no warning tint from load", () => {
	const data = cpuColors();
	const cases = [
		{ state: healthy, color: healthColors.healthy },
		{ state: { ...healthy, readiness: "ready" as const }, color: standbyColor },
		{
			state: {
				...healthy,
				readiness: "configured" as const,
				health: "unknown" as const,
			},
			color: standbyColor,
		},
		{
			state: {
				...healthy,
				readiness: "warm_ready" as const,
				activity: "working" as const,
			},
			color: healthColors.healthy,
		},
		{
			state: {
				...healthy,
				health: "pressure" as const,
				readiness: "ready" as const,
			},
			color: healthColors.pressure,
		},
		{
			state: {
				...healthy,
				health: "fault" as const,
				readiness: "ready" as const,
			},
			color: healthColors.fault,
		},
		{
			state: { ...healthy, health: "disconnected" as const, stale: true },
			color: healthColors.disconnected,
		},
	];
	for (const { state, color } of cases) {
		const hex = parseInt(color.slice(1), 16);
		const expected = [
			((hex >> 16) & 255) / 255,
			((hex >> 8) & 255) / 255,
			(hex & 255) / 255,
		];
		for (const utilization of [0, 0.5, 1])
			for (const time of [0, 7, 33600])
				for (let i = 0; i < data.length / 8; i += 31)
					expect(
						evaluateParticle(data, i, time, { ...state, utilization }).color,
					).toEqual(expected);
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

test("a disconnection stays purple at full light and distinct from a fault", () => {
	const data = cpuColors();
	const red = evaluateParticle(data, 0, 4, { ...healthy, health: "fault" });
	for (const stale of [false, true]) {
		const cut = evaluateParticle(data, 0, 4, {
			...healthy,
			health: "disconnected",
			stale,
		});
		expect(cut.color).not.toEqual(red.color);
		expect(statusColor({ ...healthy, health: "disconnected", stale })).toBe(
			healthColors.disconnected,
		);
		expect(cut.intensity).toBe(cut.baseIntensity);
	}
});
