import { boneNames } from "./skeleton";

/**
 * Flat pose channels, all additive with 0 as rest:
 * `<bone>.x|y|z` and `body.x|y|z` (radians), `body.px|py|pz` (position), `spin`
 * (accumulated vertical turns, radians), `light.*`, `eyes.close`, `eyes.gx|gy`.
 */
export type Pose = Record<string, number>;
export const motionGroups = {
	state: "状態",
	emotion: "感情と仕草",
	speech: "発話",
	"idle-gesture": "待機中の仕草",
	reaction: "触れたときの反応",
} as const;
export type MotionGroup = keyof typeof motionGroups;
const lightChannels = ["energy", "sparkle", "swirl", "core"] as const;

type Key = number[];
type MotionVariantData = {
	id: string;
	label: string;
	/** Keys are `[time, ...values]`; unsided `arm_<layer>_<joint>` keys author the right arm and mirror to the left. */
	tracks: Record<string, Key[]>;
	/** `[start, duration]` seconds. */
	blinks?: [number, number][];
};
export type MotionData = {
	id: string;
	label: string;
	group: MotionGroup;
	duration: number;
	variants: MotionVariantData[];
};
type Track = { channel: string; times: number[]; values: number[] };
export type MotionVariant = {
	id: string;
	label: string;
	tracks: Track[];
	blinks: [number, number][];
};
export type Motion = Omit<MotionData, "variants"> & {
	variants: MotionVariant[];
};

const bones = new Set<string>(boneNames);
const mirrored = /^arm_(outer|inner)_(01|02|03|tip)$/;
const limits = {
	rotation: Math.PI,
	position: 0.6,
	spin: 4 * Math.PI,
	gaze: 0.08,
};
function arity(key: string) {
	if (bones.has(key) || mirrored.test(key) || key === "body") return 3;
	if (key === "body.position") return 3;
	if (key === "eyes.gaze") return 2;
	if (key === "spin" || key === "eyes.open") return 1;
	if (
		key.startsWith("light.") &&
		(lightChannels as readonly string[]).includes(key.slice(6))
	)
		return 1;
	return 0;
}
/** Expands one authored track into channel tracks (mirroring unsided arm keys). */
function channels(key: string): { channel: string; scale: number }[][] {
	const xyz = (bone: string, sign = [1, 1, 1]) =>
		["x", "y", "z"].map((axis, i) => ({
			channel: `${bone}.${axis}`,
			scale: sign[i]!,
		}));
	const arm = mirrored.exec(key);
	if (arm)
		return [
			xyz(`arm_${arm[1]}_r_${arm[2]}`),
			xyz(`arm_${arm[1]}_l_${arm[2]}`, [1, -1, -1]),
		];
	if (key === "body.position")
		return [
			["px", "py", "pz"].map((axis) => ({
				channel: `body.${axis}`,
				scale: 1,
			})),
		];
	if (key === "eyes.gaze")
		return [
			[
				{ channel: "eyes.gx", scale: 1 },
				{ channel: "eyes.gy", scale: 1 },
			],
		];
	// Eyes are authored as openness and composed as closure, so rest stays 0.
	if (key === "eyes.open") return [[{ channel: "eyes.close", scale: -1 }]];
	if (arity(key) === 1) return [[{ channel: key, scale: 1 }]];
	return [xyz(key)];
}

/** Rejects data the renderer cannot play safely; messages name the motion and track. */
export function compileMotion(data: MotionData): Motion {
	const fail = (message: string) => {
		throw new Error(`動作 ${data.id}: ${message}`);
	};
	if (!/^[a-z][a-z0-9-]{1,40}$/.test(data.id)) fail("id が不正です");
	if (!(data.group in motionGroups)) fail("group が不正です");
	// The playback controller recovers to neutral after 8 seconds; gestures and reactions are short overlays.
	if (
		data.group === "idle-gesture" || data.group === "reaction"
			? !(data.duration >= 1 && data.duration <= 8)
			: data.duration !== 8
	)
		fail("duration が不正です");
	if (!data.variants.length) fail("変化版がありません");
	const ids = new Set<string>();
	const variants = data.variants.map((variant) => {
		if (ids.has(variant.id)) fail(`変化版 ${variant.id} が重複しています`);
		ids.add(variant.id);
		const tracks: Track[] = [];
		for (const [key, keys] of Object.entries(variant.tracks)) {
			const where = `${variant.id}.${key}`;
			const size = arity(key);
			if (!size) fail(`${where} は登録されていない track です`);
			if (keys.length < 2) fail(`${where} は2つ以上の key が必要です`);
			keys.forEach((k, i) => {
				if (k.length !== size + 1 || k.some((v) => !Number.isFinite(v)))
					fail(`${where} の key ${i} が不正です`);
				if (i && k[0]! <= keys[i - 1]![0]!)
					fail(`${where} の時刻が昇順ではありません`);
				const values = k.slice(1);
				const limit =
					key === "spin"
						? limits.spin
						: key === "body.position"
							? limits.position
							: key === "eyes.gaze"
								? limits.gaze
								: key === "eyes.open"
									? 1
									: key.startsWith("light.")
										? 3
										: limits.rotation;
				if (values.some((v) => Math.abs(v) > limit))
					fail(`${where} の値が範囲外です`);
				if (key === "eyes.open" && values[0]! < 0)
					fail(`${where} の値が範囲外です`);
			});
			const first = keys[0]!,
				last = keys.at(-1)!;
			if (first[0] !== 0 || last[0] !== data.duration)
				fail(`${where} は 0 秒と終了時刻に key が必要です`);
			const rest = key === "eyes.open" ? 1 : 0;
			const atRest = (k: Key) =>
				k.slice(1).every((v) => Math.abs(v - rest) < 1e-6);
			// Loops and recoveries meet the rest pose; a spin may end on whole turns.
			const endsAtRest =
				key === "spin" ? Math.abs(Math.sin(last[1]! / 2)) < 1e-6 : atRest(last);
			if (!atRest(first) || !endsAtRest)
				fail(`${where} は静止姿勢で始まり静止姿勢で終わる必要があります`);
			for (const targets of channels(key))
				targets.forEach(({ channel, scale }, axis) =>
					tracks.push({
						channel,
						times: keys.map((k) => k[0]!),
						values: keys.map(
							(k) => (k[axis + 1]! - (rest && axis === 0 ? rest : 0)) * scale,
						),
					}),
				);
		}
		const blinks = variant.blinks ?? [];
		for (const [at, length] of blinks)
			if (
				!(
					at >= 0 &&
					length > 0 &&
					length <= 1.2 &&
					at + length <= data.duration
				)
			)
				fail(`${variant.id} の瞬きが不正です`);
		return { id: variant.id, label: variant.label, tracks, blinks };
	});
	return { ...data, variants };
}

/** Cubic Hermite with Catmull-Rom tangents: fluid arcs, still at the ends. */
function sampleTrack({ times, values }: Track, t: number) {
	const n = times.length;
	if (t <= times[0]!) return values[0]!;
	if (t >= times[n - 1]!) return values[n - 1]!;
	let i = 0;
	while (t > times[i + 1]!) i++;
	const t0 = times[i]!,
		t1 = times[i + 1]!,
		h = t1 - t0,
		s = (t - t0) / h;
	const slope = (k: number) =>
		k <= 0 || k >= n - 1
			? 0
			: (values[k + 1]! - values[k - 1]!) / (times[k + 1]! - times[k - 1]!);
	const p0 = values[i]!,
		p1 = values[i + 1]!,
		m0 = slope(i) * h,
		m1 = slope(i + 1) * h;
	const s2 = s * s,
		s3 = s2 * s;
	return (
		(2 * s3 - 3 * s2 + 1) * p0 +
		(s3 - 2 * s2 + s) * m0 +
		(-2 * s3 + 3 * s2) * p1 +
		(s3 - s2) * m1
	);
}
const ease = (t: number) => t * t * (3 - 2 * t);
function blinkPulse(t: number, at: number, length: number) {
	const d = t - at;
	if (d < 0 || d > length) return 0;
	const peak = length * 0.38;
	return d < peak ? ease(d / peak) : 1 - ease((d - peak) / (length - peak));
}
export function sampleVariant(variant: MotionVariant, time: number): Pose {
	const pose: Pose = {};
	for (const track of variant.tracks)
		pose[track.channel] = (pose[track.channel] ?? 0) + sampleTrack(track, time);
	const blink = Math.max(
		0,
		...variant.blinks.map(([at, length]) => blinkPulse(time, at, length)),
	);
	if (blink) pose["eyes.close"] = (pose["eyes.close"] ?? 0) + blink * 0.97;
	return pose;
}
export function addPose(target: Pose, source: Pose, weight = 1) {
	if (!weight) return target;
	for (const [channel, value] of Object.entries(source))
		target[channel] = (target[channel] ?? 0) + value * weight;
	return target;
}
export function blendPose(a: Pose, b: Pose, t: number): Pose {
	const w = ease(Math.max(0, Math.min(1, t)));
	const pose: Pose = {};
	for (const channel of new Set([...Object.keys(a), ...Object.keys(b)]))
		pose[channel] = (a[channel] ?? 0) * (1 - w) + (b[channel] ?? 0) * w;
	return pose;
}
/** Folds whole turns away so a snapshot never unwinds a finished spin. */
export function wrapSpin(pose: Pose): Pose {
	const spin = pose.spin ?? 0;
	return {
		...pose,
		spin: spin - Math.round(spin / (2 * Math.PI)) * 2 * Math.PI,
	};
}
/** Deterministic hash in [0, 1). */
export function hash(value: number) {
	const x = Math.sin(value * 127.1 + 311.7) * 43758.5453;
	return x - Math.floor(x);
}
function permutation(block: number, count: number) {
	const offset = Math.floor(hash(block) * count);
	const order = Array.from({ length: count }, (_, i) => (i + offset) % count);
	return hash(block + 0.5) < 0.5 ? order : order.reverse();
}
/** Picks a variant for the n-th play; consecutive plays never repeat one. */
export function variantIndex(motion: Motion, seed: number) {
	const count = motion.variants.length;
	if (count < 2) return 0;
	const n = Math.max(0, Math.floor(seed));
	if (count === 2) return n % 2;
	const block = Math.floor(n / count),
		order = permutation(block, count);
	// Only the first two slots ever swap, so the block's last slot stays fixed.
	if (block > 0 && order[0] === permutation(block - 1, count)[count - 1])
		[order[0], order[1]] = [order[1]!, order[0]!];
	return order[n % count]!;
}
/**
 * Playback rate for the n-th play, up to 15% brisker. Never slower: playback recovers to
 * neutral after the clip's duration, so a slower clip would be cut before its rest pose.
 */
export const variantRate = (seed: number) => 1 + hash(seed + 0.25) * 0.15;
