import { sampleGazePose, sampleIdlePose } from "./idle";
import {
	addPose,
	blendPose,
	hash,
	sampleVariant,
	variantIndex,
	variantRate,
	wrapSpin,
	type Motion,
	type MotionVariant,
	type Pose,
} from "./clips";
import { motionById, motionsIn } from "./motions/index";

export type AvatarLayers = {
	/** Idle gestures every 15–40 seconds while nothing else acts. */
	gestures: boolean;
	gaze: boolean;
	/** Spring follow-through on the crown, hem and arm tips (applied by the model). */
	secondary: boolean;
};
export const defaultLayers: AvatarLayers = {
	gestures: true,
	gaze: true,
	secondary: true,
};
export type MotionChoice = { variant?: string; rate?: number };
const fade = 0.7;
const subdued = new Set(["downcast", "shy", "sleepy"]);
/** A superseded or interrupted touch reaction fades out this fast. */
const reactionFade = 0.3;
type Reaction = {
	variant: MotionVariant;
	duration: number;
	rate: number;
	/** Set on the first sampled frame, on the display clock. */
	start: number | null;
	fadeAt: number | null;
};

/** Gesture slots on the display clock: deterministic, spaced 15–40 s apart. */
function createGestureSchedule() {
	const gestures = motionsIn("idle-gesture");
	let cache = { index: 0, start: 14, gesture: 0 };
	const next = (slot: typeof cache) => {
		const motion = gestures[slot.gesture]!;
		const gap = 15 + hash(slot.index + 0.37) * 25;
		let gesture = Math.floor(hash(slot.index + 1) * gestures.length);
		if (gesture === slot.gesture) gesture = (gesture + 1) % gestures.length;
		return {
			index: slot.index + 1,
			start: slot.start + motion.duration + gap,
			gesture,
		};
	};
	return (
		time: number,
	): { motion: Motion; local: number; seed: number } | null => {
		if (!gestures.length) return null;
		if (time < cache.start) cache = { index: 0, start: 14, gesture: 0 };
		for (let n = next(cache); n.start <= time; n = next(cache)) cache = n;
		const motion = gestures[cache.gesture]!;
		const local = time - cache.start;
		return local >= 0 && local <= motion.duration
			? { motion, local, seed: cache.index }
			: null;
	};
}

/**
 * Composes the layers in order: idle → state/emotion (0.7 s crossfade) → speech overlay
 * → idle gestures → touch reaction → gaze. Spin turns into a short look-back while speaking.
 */
export function createPerformer() {
	const gestureAt = createGestureSchedule();
	let activeMode: string | null = null,
		activeSpeaking = false,
		previous: Pose = {},
		acting: Pose = {},
		idleWeight = 1,
		lastTime = 0,
		plays = 0,
		/** Per motion: the last (cue, round) seen and how many clips have started. */
		starts = new Map<string, { key: string; count: number }>(),
		choice: MotionChoice = {},
		current = { variant: "", label: "" },
		reactions: Reaction[] = [],
		reactionCount = 0;
	const fadeReactions = () => {
		// One never drawn has no start on this clock (a rebuilt playback restarts it): drop it.
		reactions = reactions.filter((reaction) => reaction.start !== null);
		for (const reaction of reactions) reaction.fadeAt ??= lastTime;
	};
	function clip(id: string, elapsed: number, loop: boolean, seed: number) {
		const motion = motionById(id);
		if (!motion) return { pose: {} as Pose, variant: "", label: "" };
		const forced = choice.variant
			? motion.variants.findIndex((v) => v.id === choice.variant)
			: -1;
		const rate = choice.rate ?? (forced >= 0 ? 1 : variantRate(seed));
		const t = Math.max(0, elapsed) * rate;
		const round = loop ? Math.floor(t / motion.duration) : 0;
		// Count clip starts per motion, so consecutive plays (cues or loop rounds) never repeat.
		const key = `${seed}:${round}`;
		const started = starts.get(id) ?? { key: "", count: -1 };
		if (started.key !== key) starts.set(id, { key, count: started.count + 1 });
		const index =
			forced >= 0 ? forced : variantIndex(motion, starts.get(id)!.count);
		const variant = motion.variants[index]!;
		const local = loop ? t - round * motion.duration : t;
		return {
			pose: sampleVariant(variant, Math.min(local, motion.duration)),
			variant: variant.id,
			label: variant.label,
		};
	}
	return {
		/** A new cue: the next frame snapshots the current pose and picks a variant. */
		begin(next: MotionChoice = {}) {
			activeMode = null;
			choice = next;
			plays++;
			// A conversation cue takes over from a touch reaction.
			fadeReactions();
		},
		/**
		 * Overlays a reaction variant on whatever plays; its tracks start and end at rest, so the
		 * motion underneath keeps its own time. Returns the playing length in seconds, 0 if unknown.
		 */
		react(variantId: string): number {
			for (const motion of motionsIn("reaction")) {
				const variant = motion.variants.find((v) => v.id === variantId);
				if (!variant) continue;
				fadeReactions();
				const rate = variantRate(++reactionCount);
				reactions.push({
					variant,
					duration: motion.duration,
					rate,
					start: null,
					fadeAt: null,
				});
				return motion.duration / rate;
			}
			return 0;
		},
		current: () => current,
		sample(
			time: number,
			mode: string,
			elapsed: number,
			speaking: boolean,
			layers: AvatarLayers,
		): Pose {
			if (activeMode !== mode || activeSpeaking !== speaking) {
				previous = wrapSpin(acting);
				activeMode = mode;
				activeSpeaking = speaking;
			}
			const main =
				mode === "neutral"
					? { pose: {}, variant: "", label: "" }
					: clip(mode, elapsed, speaking, plays);
			const performance = { ...main.pose };
			if (speaking && mode !== "speaking") {
				const speech = clip("speaking", elapsed, true, plays + 3);
				addPose(
					performance,
					speech.pose,
					mode === "neutral" ? 1 : subdued.has(mode) ? 0.35 : 0.6,
				);
				if (mode === "neutral") current = speech;
				else current = main;
			} else current = main;
			acting = blendPose(previous, performance, Math.max(0, elapsed) / fade);
			const step = Math.min(0.25, Math.max(0, time - lastTime)) / fade;
			lastTime = time;
			const idleTarget = mode === "neutral" && !speaking ? 1 : 0;
			idleWeight += Math.max(-step, Math.min(step, idleTarget - idleWeight));
			const pose = addPose(sampleIdlePose(time, idleWeight), acting);
			const touch: Pose = {};
			let touching = 0;
			reactions = reactions.filter((reaction) => {
				reaction.start ??= time;
				const local = (time - reaction.start) * reaction.rate;
				const weight =
					reaction.fadeAt === null
						? 1
						: 1 - (time - reaction.fadeAt) / reactionFade;
				if (local < 0 || local >= reaction.duration || weight <= 0)
					return false;
				addPose(touch, sampleVariant(reaction.variant, local), weight);
				touching = Math.max(touching, weight);
				return true;
			});
			if (layers.gestures && idleWeight > 0 && touching < 1) {
				const gesture = gestureAt(time);
				if (gesture)
					addPose(
						pose,
						sampleVariant(
							gesture.motion.variants[
								variantIndex(gesture.motion, gesture.seed)
							]!,
							gesture.local,
						),
						idleWeight * idleWeight * (3 - 2 * idleWeight) * (1 - touching),
					);
			}
			addPose(pose, touch, mode === "neutral" && !speaking ? 1 : 0.7);
			if (layers.gaze)
				addPose(
					pose,
					sampleGazePose(time, pose["body.y"] ?? 0, 0.5 + idleWeight * 0.5),
				);
			if (speaking && pose.spin) {
				// A full turn would hide the face mid-sentence: look back over a shoulder instead.
				pose["body.y"] = (pose["body.y"] ?? 0) + 0.35 * Math.sin(pose.spin / 2);
				pose.spin = 0;
			}
			return pose;
		},
	};
}
