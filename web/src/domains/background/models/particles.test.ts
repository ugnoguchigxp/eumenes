import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { Points, ShaderMaterial } from "three";
import { createParticleModel } from "./particles";
import { decodeParticles, particleModelIds } from ".";
import {
	activityStrength,
	defaultSpatialOptions,
	healthColors,
} from "../options";

function fixture(id: string) {
	const descriptor = JSON.parse(
		readFileSync(
			resolve("web/src/domains/background/models/assets", `${id}.json`),
			"utf8",
		),
	);
	const bytes = readFileSync(
		resolve("web/src/domains/background/models/assets", `${id}.bin`),
	);
	const points = decodeParticles(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		descriptor,
	);
	return { descriptor, bytes, points };
}

test("all 12 original interleaved models retain their counts and CPU source coordinates", () => {
	let total = 0;
	for (const [index, id] of particleModelIds.entries()) {
		const data = fixture(id);
		total += data.descriptor.pointCount;
		const model = createParticleModel({
			id,
			index,
			radius: data.descriptor.normalizationRadius,
			points: data.points,
		});
		const geometry = (model.object.children[0] as Points).geometry;
		expect(geometry.getAttribute("position").count).toBe(
			data.descriptor.pointCount,
		);
		expect(geometry.getAttribute("aSeed").count).toBe(
			data.descriptor.pointCount,
		);
		model.dispose();
		model.dispose();
	}
	expect(total).toBe(29952);
	expect(createHash("sha256").update(fixture("cpu").bytes).digest("hex")).toBe(
		"0fb9ff086be67b3307dbef48c031a76ce21b03fd79380c79478b00e539fd8e60",
	);
});

test("health, selection, utilization and activity are independent; stale/reduced motion gates activity", () => {
	const data = fixture("cpu");
	const model = createParticleModel({
		id: "cpu",
		index: 0,
		radius: data.descriptor.normalizationRadius,
		points: data.points,
	});
	const u = ((model.object.children[0] as Points).material as ShaderMaterial)
		.uniforms;
	for (const health of Object.keys(
		healthColors,
	) as (keyof typeof healthColors)[]) {
		model.update(
			{
				health,
				activity: "working",
				stale: false,
				utilization: 1,
				strength: 0.7,
			},
			false,
		);
		expect("#" + u.uHealthColor!.value.getHexString()).toBe(
			healthColors[health],
		);
	}
	model.update(
		{ health: "healthy", activity: "idle", stale: false, utilization: 1 },
		true,
	);
	expect(u.uHealthColor!.value.getHexString()).toBe("ffffff");
	expect(u.uActivityState!.value).toBe(0);
	model.update(
		{ health: "healthy", activity: "working", stale: true, strength: 1 },
		false,
	);
	expect(u.uActivity!.value).toBe(0);
	model.configure?.(defaultSpatialOptions, 60, false);
	expect(u.uMotion!.value).toBe(0);
	expect(u.uCoreFraction!.value).toBe(0.6);
	model.update(
		{ health: "healthy", activity: "working", stale: false, utilization: NaN },
		false,
	);
	for (let i = 0; i < 10000; i++) model.animate?.(i, 100);
	for (const key of ["uOrbitAngle", "uWavePhase", "uFlowPhase", "uPulsePhase"])
		expect(Number.isFinite(u[key]!.value)).toBe(true);
	model.dispose();
});

test("malformed assets are rejected and absent observations do not imply activity", () => {
	expect(() =>
		decodeParticles(new ArrayBuffer(4), {
			pointCount: 1,
			stride: 8,
			normalizationRadius: 1,
		}),
	).toThrow();
	expect(
		activityStrength({
			health: "unknown",
			activity: "working",
			stale: false,
			strength: 1,
		}),
	).toBe(0);
	expect(
		activityStrength({
			health: "disconnected",
			activity: "working",
			stale: false,
			strength: 1,
		}),
	).toBe(0);
});
