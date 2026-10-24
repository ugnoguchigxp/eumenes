import type { SpatialState } from "../contracts";
import { healthColors, particleColorOptions as colorOptions } from "../options";
import type { ParticleModelId } from "./catalog";
export type ParticleColorMix = {
	animatedFraction: number;
	warmFraction: number;
};
export type AnimationInput = SpatialState & {
	model: ParticleModelId;
	reducedMotion: boolean;
	staticBrightnessByGroup?: Readonly<Record<number, number>>;
	capacityUsed?: number;
	loadedSeats?: readonly number[];
	loadingSeats?: readonly number[];
	startingProgress?: number;
	faultEventAge?: number;
	thermalThrottle?: boolean;
	baseBrightness?: number;
	/** Smoothed rendering fractions supplied by the model, never inferred health. */
	colorMix?: ParticleColorMix;
};
export type ParticleSample = {
	intensity: number;
	baseIntensity: number;
	uplift: number;
	color: [number, number, number];
	size: number;
};
const PERIODS: Record<ParticleModelId, number> = {
	cpu: 16,
	memory: 12,
	ssd: 12,
	backend: 12,
	external: 12,
	llm: 12,
	asr: 10,
	tts: 10,
	embedding: 12,
	attitude: 12,
	"larm-core": 16,
	"larm-cpu": 16,
	"larm-memory": 14,
	"larm-gpu": 14,
};
const TAU = Math.PI * 2;
const clamp = (v: number, fallback = 0) =>
	Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
const wrap = (v: number) => ((v % 1) + 1) % 1;
const rgb = (hex: string): readonly [number, number, number] => {
	const value = parseInt(hex.slice(1), 16);
	return [
		((value >> 16) & 255) / 255,
		((value >> 8) & 255) / 255,
		(value & 255) / 255,
	];
};
const healthRgb = Object.fromEntries(
	Object.entries(healthColors).map(([health, color]) => [health, rgb(color)]),
) as Record<SpatialState["health"], readonly [number, number, number]>;
const coolRgb = colorOptions.coolPalette.map(rgb);
const warmRgb = colorOptions.warmPalette.map(rgb);
/** Cheap, deterministic independent streams; no random calls or per-point allocations. */
const hash = (value: number) => {
	let bits = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
	bits = Math.imul(bits ^ (bits >>> 16), 0x45d9f3b);
	return ((bits ^ (bits >>> 16)) >>> 0) / 0x100000000;
};
const membership = (
	seed: number,
	fraction: number,
	width: number = colorOptions.selectionBlend,
) => {
	const value = clamp((fraction - seed) / width);
	return value * value * (3 - 2 * value);
};
function paintColor(
	out: ParticleSample["color"],
	seed: number,
	phase: number,
	group: number,
	time: number,
	input: AnimationInput,
	stopped: boolean,
) {
	if (input.health !== "healthy") {
		const color = healthRgb[input.health];
		out[0] = color[0];
		out[1] = color[1];
		out[2] = color[2];
		return;
	}
	const identity =
		(seed * 0xffffff) ^ (phase * 0xffff) ^ Math.imul(group, 0x9e3779b9);
	const base = hash(identity),
		cycle = hash(identity ^ 0x68bc21eb),
		active = hash(identity ^ 0x02e5be93),
		warm = hash(identity ^ 0x967a889b);
	const index = Math.min(coolRgb.length - 1, Math.floor(base * coolRgb.length));
	const first = coolRgb[index]!,
		second = coolRgb[(index + 1) % coolRgb.length]!,
		warmColor =
			warmRgb[Math.min(warmRgb.length - 1, Math.floor(base * warmRgb.length))]!;
	const duration =
		colorOptions.transitionSeconds[
			Math.min(
				colorOptions.transitionSeconds.length - 1,
				Math.floor(cycle * colorOptions.transitionSeconds.length),
			)
		]!;
	const animatedFraction =
		input.colorMix?.animatedFraction ??
		colorOptions.animatedFraction[input.activity];
	const blend = stopped
		? 0
		: membership(active, animatedFraction) *
			(0.5 - 0.5 * Math.cos(Math.PI * (time / duration + base * 2)));
	const warmFraction =
		input.utilization === undefined
			? 0
			: (input.colorMix?.warmFraction ??
				clamp(input.utilization) * colorOptions.warmFractionAtFullUtilization);
	const warmth = membership(
		warm,
		warmFraction,
		colorOptions.warmSelectionBlend,
	);
	for (let channel = 0; channel < 3; channel++) {
		const cool = first[channel]! + (second[channel]! - first[channel]!) * blend;
		out[channel] = cool + (warmColor[channel]! - cool) * warmth;
	}
}
const pulse = (phase: number, progress: number, width = 0.18) => {
	const d = Math.abs(wrap(phase - progress + 0.5) - 0.5);
	return Math.max(0, 1 - d / width) ** 2;
};
/** Fixed coordinates/sizes, bounded brightness and asynchronous healthy star colours. */
export function evaluateParticle(
	data: Float32Array,
	index: number,
	time: number,
	input: AnimationInput,
	out: ParticleSample = {
		intensity: 0,
		baseIntensity: 0,
		uplift: 0,
		color: [0, 0, 0],
		size: 0,
	},
) {
	const s = input,
		p = index * 8;
	if (!Number.isInteger(index) || index < 0 || p + 8 > data.length)
		throw new RangeError("Particle index out of bounds");
	const phase = data[p + 3]!,
		group = data[p + 4]!,
		m = s.model;
	const t = (((Number.isFinite(time) ? time : 0) % 33600) + 33600) % 33600;
	const stopped =
		s.stale ||
		s.reducedMotion ||
		s.health === "disconnected" ||
		s.health === "unknown";
	let staticFactor = 1;
	// Explicit observed values only; missing values remain absent, never treated as zero.
	const observed = s.staticBrightnessByGroup?.[group];
	if (observed !== undefined && Number.isFinite(observed))
		staticFactor = 0.55 + 0.45 * clamp(observed);
	if (
		m === "ssd" &&
		s.capacityUsed !== undefined &&
		Number.isFinite(s.capacityUsed)
	)
		staticFactor = phase <= clamp(s.capacityUsed) ? 1 : 0.62;
	if (
		m === "larm-core" &&
		group >= 1 &&
		group <= 6 &&
		Array.isArray(s.loadedSeats)
	)
		staticFactor = s.loadedSeats.includes(group) ? 1 : 0.62;
	let uplift = 0,
		speed = s.activity === "working" ? 1.15 : 1;
	let progress = wrap((t / PERIODS[m]) * speed);
	const breath = 0.5 + 0.5 * Math.sin((TAU * t) / 12);
	if (!stopped) {
		if (s.health === "fault") {
			uplift = 0.012 * breath;
			// Caller supplies age only for a newly detected, deduplicated observed event.
			if (
				s.faultEventAge !== undefined &&
				Number.isFinite(s.faultEventAge) &&
				s.faultEventAge >= 0 &&
				s.faultEventAge < 1
			)
				uplift += 0.07 * Math.sin(Math.PI * s.faultEventAge) ** 2;
		} else if (s.health === "pressure") {
			// No activity-speed increase under pressure. Preserve structure and calm local glow.
			if (m === "backend") uplift = group === 0 ? 0.055 : 0;
			else if (m === "memory") uplift = group === 3 ? 0.045 : 0;
			else if (m === "larm-memory") uplift = group < 30 ? 0.035 : 0;
			else if (m === "larm-gpu")
				uplift = s.thermalThrottle
					? 0.025
					: 0.035 * pulse(phase, wrap((t / PERIODS[m]) * 0.35));
			else uplift = 0.018 * breath;
		} else {
			uplift = 0.018 * breath;
			if (s.activity === "working" && m !== "ssd") {
				let wave = pulse(phase, progress);
				if (m === "llm")
					wave = Math.max(wave, 0.45 * pulse(phase, wrap(progress + 0.5)));
				if (m === "attitude") wave = pulse(phase, wrap(progress - group * 0.1));
				if (m === "memory") wave = pulse(phase, wrap(progress - group * 0.08));
				if (m === "larm-core" && group !== 7) wave = 0;
				if (m === "larm-memory" && group >= 30) wave *= 0.2;
				if (m === "cpu" && group !== 2) wave = 0;
				uplift += 0.052 * wave;
			}
			if (
				s.activity === "starting" &&
				!["cpu", "memory", "ssd", "larm-cpu", "larm-memory"].includes(m)
			) {
				const fill =
					s.startingProgress !== undefined &&
					Number.isFinite(s.startingProgress)
						? clamp(s.startingProgress)
						: null;
				let glow = fill === null ? 0 : phase <= fill ? 1 : 0;
				if (m === "llm") glow = fill ?? 0;
				if (m === "tts") glow = group === 0 ? breath : 0;
				if (m === "embedding" && group !== 2) glow = 0;
				if (m === "attitude" && phase > 0.22) glow = 0;
				if (m === "asr" && group !== 2) glow = 0;
				if (
					m === "larm-core" &&
					!(Array.isArray(s.loadingSeats) && s.loadingSeats.includes(group))
				)
					glow = 0;
				uplift += 0.052 * glow;
			}
			uplift += 0.03 * (s.utilization ?? 0);
		}
	}
	// Static utilization is allowed under reduced motion, without temporal changes.
	if (s.reducedMotion && s.health === "healthy" && !s.stale)
		uplift = 0.03 * (s.utilization ?? 0);
	// A disconnection has no fresh value by nature; its red stays at full light (spec §12).
	const dim = s.health === "unknown" ? 0.65 : 1;
	const old = s.stale && s.health !== "disconnected";
	const base =
		(s.baseBrightness !== undefined && Number.isFinite(s.baseBrightness)
			? Math.max(0, s.baseBrightness)
			: 0.7) *
		Math.max(0, data[p + 7]!) *
		staticFactor;
	out.intensity =
		base * (1 + Math.min(0.1, Math.max(0, uplift))) * dim * (old ? 0.45 : 1);
	out.baseIntensity = base;
	out.uplift = Math.min(0.1, Math.max(0, uplift));
	paintColor(out.color, data[p + 5]!, phase, group, t, s, !!stopped);
	out.size = data[p + 6]!;
	return out;
}
