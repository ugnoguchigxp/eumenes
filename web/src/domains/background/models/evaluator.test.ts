import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { evaluateParticle, type AnimationInput } from "./evaluator";
import { particleModelIds } from "./catalog";
import { healthColors, particleColorOptions } from "../options";
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
						if (health !== "healthy") {
							const hex = parseInt(healthColors[health].slice(1), 16);
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

test("healthy stars retain distinct cool colours and only a distributed fraction changes slowly", () => {
	const data = cpuColors();
	let idleChanges = 0,
		workingChanges = 0,
		rising = 0,
		falling = 0;
	const colours = new Set<string>();
	for (let i = 0; i < data.length / 8; i++) {
		const at = evaluateParticle(data, i, 2, healthy).color;
		const next = evaluateParticle(data, i, 3, healthy).color;
		colours.add(at.map((v) => v.toFixed(2)).join(","));
		const difference = next[0] - at[0];
		if (at.some((v, c) => Math.abs(v - next[c]!) > 1e-6)) idleChanges++;
		if (difference > 1e-5) rising++;
		if (difference < -1e-5) falling++;
		const working = { ...healthy, activity: "working" as const };
		const activeAt = evaluateParticle(data, i, 2, working).color;
		const activeNext = evaluateParticle(data, i, 3, working).color;
		if (activeAt.some((v, c) => Math.abs(v - activeNext[c]!) > 1e-6))
			workingChanges++;
		const frame = evaluateParticle(data, i, 2 + 1 / 30, healthy).color;
		expect(Math.max(...at.map((v, c) => Math.abs(v - frame[c]!)))).toBeLessThan(
			0.007,
		);
		expect(evaluateParticle(data, i, 33600, healthy).color).toEqual(
			evaluateParticle(data, i, 0, healthy).color,
		);
		const beforeWrap = evaluateParticle(data, i, 33600 - 1 / 30, healthy).color;
		const afterWrap = evaluateParticle(data, i, 0, healthy).color;
		expect(
			Math.max(...beforeWrap.map((v, c) => Math.abs(v - afterWrap[c]!))),
		).toBeLessThan(0.007);
	}
	const count = data.length / 8;
	expect(colours.size).toBeGreaterThan(100);
	expect(idleChanges / count).toBeGreaterThan(0.35);
	expect(idleChanges / count).toBeLessThan(0.5);
	expect(workingChanges / count).toBeGreaterThan(0.6);
	expect(workingChanges / count).toBeLessThan(0.75);
	expect(rising).toBeGreaterThan(count * 0.1);
	expect(falling).toBeGreaterThan(count * 0.1);
});

test("only observed utilization increases the warm-star fraction, independently of scatter cohorts", () => {
	const data = cpuColors(),
		counts = [0, 0, 0],
		byDecile = Array<number>(10).fill(0),
		totals = Array<number>(10).fill(0);
	for (let i = 0; i < data.length / 8; i++) {
		const absent = evaluateParticle(data, i, 4, healthy).color;
		expect(
			evaluateParticle(data, i, 4, { ...healthy, utilization: 0 }).color,
		).toEqual(absent);
		for (const [index, utilization] of [0, 0.5, 1].entries()) {
			const color = evaluateParticle(data, i, 4, {
				...healthy,
				utilization,
			}).color;
			if (color[0] > color[2]) {
				counts[index]!++;
				if (utilization === 1)
					byDecile[Math.min(9, Math.floor(data[i * 8 + 5]! * 10))]!++;
			}
		}
		totals[Math.min(9, Math.floor(data[i * 8 + 5]! * 10))]!++;
	}
	expect(counts[0]).toBe(0);
	expect(counts[1]).toBeGreaterThan(0);
	expect(counts[2]).toBeGreaterThan(counts[1]!);
	expect(counts[2]! / (data.length / 8)).toBeGreaterThan(
		particleColorOptions.warmFractionAtFullUtilization - 0.08,
	);
	expect(counts[2]! / (data.length / 8)).toBeLessThan(
		particleColorOptions.warmFractionAtFullUtilization + 0.04,
	);
	for (let band = 0; band < 10; band++)
		expect(byDecile[band]! / totals[band]!).toBeGreaterThan(0.2);
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

test("a disconnection shows fault red at full light, even without a fresh value", () => {
	const data = cpuColors();
	const red = evaluateParticle(data, 0, 4, { ...healthy, health: "fault" });
	for (const stale of [false, true]) {
		const cut = evaluateParticle(data, 0, 4, {
			...healthy,
			health: "disconnected",
			stale,
		});
		expect(cut.color).toEqual(red.color);
		expect(cut.intensity).toBe(cut.baseIntensity);
	}
});
