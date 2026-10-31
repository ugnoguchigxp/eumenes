import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	Group,
	InterleavedBuffer,
	InterleavedBufferAttribute,
	Points,
	ShaderMaterial,
} from "three";
import type { SpatialModel, SpatialState } from "../contracts";
import { particleModelIds } from "./catalog";
import {
	evaluateParticle,
	type AnimationInput,
	type ParticleSample,
} from "./evaluator";
import { fragmentShader, vertexShader } from "./shaders";
import { createParticleEnvelope, PARTICLE_MODEL_SCALE } from "./envelope";

export type ParticleData = {
	id: string;
	index: number;
	radius: number;
	points: Float32Array;
};

/** Adopted fixed geometry and light evaluator; the existing scene owns the only loop. */
export function createParticleModel(data: ParticleData): SpatialModel {
	const id = particleModelIds.find((value) => value === data.id);
	if (!id) throw new Error("invalid_particle_model");
	const object = new Group();
	object.scale.setScalar(PARTICLE_MODEL_SCALE);
	const geometry = new BufferGeometry(),
		buffer = new InterleavedBuffer(data.points, 8);
	geometry.setAttribute(
		"position",
		new InterleavedBufferAttribute(buffer, 3, 0),
	);
	for (const [offset, name] of [
		"aPhase",
		"aGroup",
		"aSeed",
		"aSize",
		"aWeight",
	].entries())
		geometry.setAttribute(
			name,
			new InterleavedBufferAttribute(buffer, 1, offset + 3),
		);
	const colors = new Float32Array((data.points.length / 8) * 3);
	const color = new BufferAttribute(colors, 3);
	geometry.setAttribute("color", color);
	const uniforms = {
		pixelRatio: { value: 1 },
		uScatter: { value: 3.5 },
		uCoreFraction: { value: 0.4 },
		uCoreStart: { value: 0.4 },
		uCoreEnd: { value: 0.6 },
		uNormalization: { value: 1 / data.radius },
		uFocus: { value: 0 },
		uVisibility: { value: 1 },
	};
	const material = new ShaderMaterial({
		uniforms,
		vertexShader,
		fragmentShader,
		transparent: true,
		vertexColors: true,
		depthWrite: false,
		depthTest: false,
		blending: AdditiveBlending,
	});
	const points = new Points(geometry, material);
	points.frustumCulled = false;
	object.add(points);
	let current: SpatialState = {
			health: "unknown",
			activity: "idle",
			stale: false,
		},
		motion = true,
		selected = false,
		time = 0,
		destroyed = false;
	const canAnimate = () =>
		motion &&
		!current.stale &&
		current.health !== "unknown" &&
		current.health !== "disconnected";
	const sample: ParticleSample = {
		intensity: 0,
		baseIntensity: 0,
		uplift: 0,
		color: [0, 0, 0],
		size: 0,
	};
	function paint() {
		const input: AnimationInput = {
			...current,
			model: id!,
			reducedMotion: !motion,
			utilization: Number.isFinite(current.utilization)
				? Math.max(0, Math.min(1, current.utilization!))
				: undefined,
		};
		for (let i = 0; i < data.points.length / 8; i++) {
			evaluateParticle(data.points, i, time, input, sample);
			const j = i * 3;
			colors[j] = sample.color[0] * sample.intensity;
			colors[j + 1] = sample.color[1] * sample.intensity;
			colors[j + 2] = sample.color[2] * sample.intensity;
		}
		color.needsUpdate = true;
	}
	return {
		object,
		bounds: createParticleEnvelope(data),
		update(state, isSelected) {
			current = state;
			selected = isSelected;
			paint();
		},
		configure(next, core, motionEnabled, visibility = 1) {
			const changed = motion !== motionEnabled;
			motion = motionEnabled;
			uniforms.uScatter.value = next.scatter / 100;
			uniforms.uCoreFraction.value = core / 100;
			uniforms.uCoreStart.value = next.core / 100;
			uniforms.uCoreEnd.value = next.focusCore / 100;
			const span = next.focusCore - next.core;
			uniforms.uFocus.value = span
				? Math.max(0, Math.min(1, (core - next.core) / span))
				: Number(selected);
			uniforms.pixelRatio.value =
				(Math.min(window.devicePixelRatio || 1, 1.5) * next.pointSize) / 100;
			uniforms.uVisibility.value = (visibility * next.opacity) / 100;
			if (changed) {
				paint();
			}
		},
		animate(seconds) {
			if (!canAnimate()) return;
			time = seconds;
			paint();
		},
		dispose() {
			if (destroyed) return;
			destroyed = true;
			geometry.dispose();
			material.dispose();
		},
	};
}
