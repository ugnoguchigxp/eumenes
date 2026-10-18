import {
	AdditiveBlending,
	BufferGeometry,
	Color,
	Group,
	InterleavedBuffer,
	InterleavedBufferAttribute,
	Points,
	ShaderMaterial,
} from "three";
import type { SpatialModel, SpatialState } from "../contracts";
import {
	activityStrength,
	defaultSpatialOptions,
	healthColors,
} from "../options";
import { fragmentShader, vertexShader } from "./shaders";
import { createParticleEnvelope, PARTICLE_MODEL_SCALE } from "./envelope";

export type ParticleData = {
	id: string;
	index: number;
	radius: number;
	points: Float32Array;
};
const TAU = 2 * Math.PI;

/** One immutable interleaved point buffer; activity, shape diffusion and CPU motion run on GPU. */
export function createParticleModel(data: ParticleData): SpatialModel {
	const object = new Group();
	object.scale.setScalar(PARTICLE_MODEL_SCALE);
	const bounds = createParticleEnvelope(data);
	const geometry = new BufferGeometry();
	const buffer = new InterleavedBuffer(data.points, 8);
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
	const uniforms = {
		uScatter: { value: 1 },
		uCoreFraction: { value: 0.4 },
		uNormalization: { value: 1 / data.radius },
		uModel: { value: data.index },
		uPointSize: { value: 2.5 },
		uActivity: { value: 0 },
		uActivityState: { value: 0 },
		uFlowPhase: { value: 0 },
		uPulsePhase: { value: 0 },
		uMotion: { value: 1 },
		uOrbitAngle: { value: 0 },
		uWavePhase: { value: 0 },
		uHealthColor: { value: new Color(healthColors.unknown) },
		uHealthIntensity: { value: 0.8 },
		uVisibility: { value: 1 },
	};
	const material = new ShaderMaterial({
		uniforms,
		vertexShader,
		fragmentShader,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		blending: AdditiveBlending,
	});
	const points = new Points(geometry, material);
	points.frustumCulled = false; // Vertex shader changes the CPU-side bounding sphere.
	object.add(points);
	let current: SpatialState = {
		health: "unknown",
		activity: "idle",
		stale: false,
	};
	let options = defaultSpatialOptions;
	let destroyed = false;
	return {
		object,
		bounds,
		update(state, selected) {
			current = state;
			uniforms.uHealthColor.value.set(
				selected ? "#ffffff" : healthColors[state.health],
			);
			uniforms.uHealthIntensity.value =
				(state.health === "unknown"
					? 0.8
					: state.health === "disconnected"
						? 0.28
						: 1) * (state.stale ? 0.45 : 1);
			uniforms.uActivity.value = activityStrength(state);
			uniforms.uActivityState.value =
				activityStrength(state) === 0
					? 0
					: state.activity === "starting"
						? 1
						: 2;
		},
		configure(next, core, motionEnabled, visibility = 1) {
			options = next;
			uniforms.uScatter.value = next.scatter / 100;
			uniforms.uCoreFraction.value = core / 100;
			uniforms.uPointSize.value =
				((2.5 * next.pointSize) / 100) *
				Math.min(window.devicePixelRatio || 1, 1.5);
			uniforms.uMotion.value = motionEnabled ? 1 : 0;
			uniforms.uVisibility.value = (visibility * next.opacity) / 100;
		},
		animate(_seconds, delta) {
			const dt = Math.min(0.05, Math.max(0, delta));
			const strength = activityStrength(current);
			uniforms.uFlowPhase.value =
				(uniforms.uFlowPhase.value + (0.13 + 1.6 * strength) * dt) % TAU;
			uniforms.uPulsePhase.value =
				(uniforms.uPulsePhase.value + (0.3 + 1.7 * strength) * dt) % TAU;
			if (data.index === 0) {
				const utilization = Number.isFinite(current.utilization)
					? Math.max(0, Math.min(1, current.utilization ?? 0))
					: 0;
				uniforms.uOrbitAngle.value =
					(uniforms.uOrbitAngle.value +
						(((0.12 + 0.9 * utilization ** 1.5) * options.spinSpeed) / 100) *
							dt) %
					TAU;
				uniforms.uWavePhase.value =
					(uniforms.uWavePhase.value + (0.5 + 1.5 * strength) * dt) %
					(Math.PI * 20);
			} else
				object.rotation.z =
					(object.rotation.z + ((0.18 * options.spinSpeed) / 100) * dt) % TAU;
		},
		dispose() {
			if (destroyed) return;
			destroyed = true;
			geometry.dispose();
			material.dispose();
		},
	};
}
