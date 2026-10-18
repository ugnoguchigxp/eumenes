import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { Points } from "three";
import { createParticleModel } from "./particles";
import { decodeParticles, particleModelIds } from ".";
import {
	defaultSpatialOptions,
	healthColors,
	particleColorOptions,
} from "../options";
import { evaluateParticle } from "./evaluator";
import hashes from "./source-hashes.json";
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
	return {
		descriptor,
		bytes,
		points: decodeParticles(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			descriptor,
		),
	};
}
test("all 14 adopted models retain their hashes, 33460 points and immutable local coordinates", () => {
	let total = 0;
	for (const [index, id] of particleModelIds.entries()) {
		const data = fixture(id),
			before = data.points.slice();
		total += data.descriptor.pointCount;
		expect(createHash("sha256").update(data.bytes).digest("hex")).toBe(
			hashes[id],
		);
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
		model.configure?.(defaultSpatialOptions, 60, true);
		for (const health of Object.keys(
			healthColors,
		) as (keyof typeof healthColors)[]) {
			model.update(
				{ health, activity: "working", stale: false, utilization: 1 },
				true,
			);
			model.animate?.(10, 0.05);
		}
		expect(data.points).toEqual(before);
		expect(model.object.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
		model.dispose();
		model.dispose();
	}
	expect(particleModelIds).toHaveLength(14);
	expect(total).toBe(33460);
});
test("health colour survives selection and time only changes healthy light; pause and old observations stop it", () => {
	const d = fixture("llm"),
		model = createParticleModel({
			id: "llm",
			index: 5,
			radius: d.descriptor.normalizationRadius,
			points: d.points,
		});
	const attr = (model.object.children[0] as Points).geometry.getAttribute(
		"color",
	);
	const light = () => Array.from(attr.array);
	model.configure?.(defaultSpatialOptions, 60, true);
	for (const health of Object.keys(
		healthColors,
	) as (keyof typeof healthColors)[]) {
		const state = { health, activity: "working" as const, stale: false };
		model.update(state, false);
		const before = light();
		model.update(state, true);
		expect(light()).toEqual(before);
	}
	model.update({ health: "healthy", activity: "working", stale: false }, true);
	const before = light();
	model.animate?.(2, 0.05);
	expect(light()).not.toEqual(before);
	for (const state of [
		{ health: "unknown" as const, stale: false },
		{ health: "disconnected" as const, stale: false },
		{ health: "healthy" as const, stale: true },
	]) {
		model.update({ ...state, activity: "working" }, false);
		const before = light();
		model.animate?.(100, 0.05);
		expect(light()).toEqual(before);
	}
	model.update({ health: "healthy", activity: "working", stale: false }, false);
	model.configure?.(defaultSpatialOptions, 60, false);
	const stopped = light();
	model.animate?.(1000, 0.05);
	expect(light()).toEqual(stopped);
	model.dispose();
});
test("malformed assets are rejected", () => {
	expect(() =>
		decodeParticles(new ArrayBuffer(4), {
			pointCount: 1,
			stride: 8,
			normalizationRadius: 1,
		}),
	).toThrow();
});

test("the actual colour buffer receives per-star evaluator RGB without replacing arrays or geometry", () => {
	const d = fixture("cpu"),
		model = createParticleModel({
			id: "cpu",
			index: 0,
			radius: d.descriptor.normalizationRadius,
			points: d.points,
		});
	const geometry = (model.object.children[0] as Points).geometry;
	const attr = geometry.getAttribute("color"),
		buffer = attr.array;
	const state = {
		health: "healthy" as const,
		activity: "idle" as const,
		stale: false,
		utilization: 0.5,
	};
	model.configure?.(defaultSpatialOptions, 40, true);
	model.update(state, false);
	model.animate?.(3, 0.05);
	const input = { ...state, model: "cpu" as const, reducedMotion: false };
	const expected = evaluateParticle(d.points, 0, 3, input);
	const channels = expected.color;
	for (let i = 0; i < d.points.length / 8; i += 17) {
		expect(evaluateParticle(d.points, i, 3, input, expected)).toBe(expected);
		expect(expected.color).toBe(channels);
		for (let channel = 0; channel < 3; channel++)
			expect(attr.array[i * 3 + channel]).toBeCloseTo(
				expected.color[channel]! * expected.intensity,
				6,
			);
	}
	model.animate?.(5, 0.05);
	expect(geometry.getAttribute("color").array).toBe(buffer);
	model.dispose();
});

test("observed load transitions over seconds, identical reads do not restart it, and fault red is immediate", () => {
	const d = fixture("cpu"),
		model = createParticleModel({
			id: "cpu",
			index: 0,
			radius: d.descriptor.normalizationRadius,
			points: d.points,
		});
	const attr = (model.object.children[0] as Points).geometry.getAttribute(
		"color",
	);
	const state = {
		health: "healthy" as const,
		activity: "idle" as const,
		stale: false,
		utilization: 0,
	};
	const warmCount = () => {
		let count = 0;
		for (let i = 0; i < attr.count; i++)
			if (attr.getX(i) > attr.getZ(i)) count++;
		return count;
	};
	model.configure?.(defaultSpatialOptions, 40, true);
	model.update(state, false);
	const before = Array.from(attr.array);
	model.update({ ...state, utilization: 1 }, false);
	// Existing utilization brightness changes immediately; hue starts from its displayed value.
	let hueDifference = 0;
	for (let i = 0; i < attr.count; i++) {
		const oldMax = Math.max(...before.slice(i * 3, i * 3 + 3));
		const nextMax = Math.max(attr.getX(i), attr.getY(i), attr.getZ(i));
		for (let c = 0; c < 3; c++)
			hueDifference = Math.max(
				hueDifference,
				Math.abs(
					attr.array[i * 3 + c]! / nextMax - before[i * 3 + c]! / oldMax,
				),
			);
	}
	expect(hueDifference).toBeLessThan(1e-6);
	model.animate?.(2, 2);
	const early = warmCount();
	model.update({ ...state, utilization: 1 }, true);
	model.animate?.(4, 2);
	const middle = warmCount();
	model.animate?.(8, 4);
	const complete = warmCount();
	expect(middle).toBeGreaterThan(early);
	expect(complete).toBeGreaterThan(middle);
	expect(complete / attr.count).toBeGreaterThan(0.3);
	for (let i = 0; i < attr.count; i += 31) {
		const expected = evaluateParticle(d.points, i, 8, {
			...state,
			utilization: 1,
			model: "cpu",
			reducedMotion: false,
		});
		expect(attr.getX(i)).toBeCloseTo(expected.color[0] * expected.intensity, 6);
	}
	model.update({ ...state, health: "fault", utilization: 1 }, false);
	for (let i = 0; i < attr.count; i += 31) {
		expect(attr.getY(i) / attr.getX(i)).toBeCloseTo(0x61 / 0xff, 6);
		expect(attr.getZ(i) / attr.getX(i)).toBeCloseTo(0x77 / 0xff, 6);
	}
	model.update({ ...state, utilization: 1 }, false);
	model.configure?.(defaultSpatialOptions, 40, false);
	model.update(state, false);
	const stopped = Array.from(attr.array);
	model.animate?.(100, particleColorOptions.stateTransitionSeconds);
	expect(Array.from(attr.array)).toEqual(stopped);
	expect(warmCount()).toBe(0);
	model.dispose();
});
