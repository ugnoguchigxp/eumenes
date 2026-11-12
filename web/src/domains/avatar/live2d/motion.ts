import type * as Cubism from "../../../../../vendor/live2d/framework.js";
import type {
	AvatarMotion,
	DeliveryEmotion,
} from "../../../../../api/domains/delivery/contracts";
import type { AvatarCue } from "../controller";

type MotionRef = { File: string; FadeInTime?: number; FadeOutTime?: number };
export type HiyoriMotionReferences = Record<string, MotionRef[]>;

// Hiyori's official files are numbered, without emotion labels. Use the gestures and
// expressions in those files to match the already selected emotion.
const emotionClips: Record<Exclude<DeliveryEmotion, "none">, string> = {
	warmth: "01",
	joy: "08",
	empathy: "10",
	curiosity: "03",
	surprise: "07",
	enjoyment: "05",
	wry: "01",
	admiration: "06",
	relief: "08",
	shy: "02",
	confusion: "03",
	sadness: "10",
	apologetic: "10",
	worry: "09",
	dislike: "09",
	anger: "04",
};

const motionClips: Partial<Record<AvatarMotion, string>> = {
	agreeing: "01",
	joyful: "08",
	curious: "03",
	surprised: "07",
	downcast: "10",
	shy: "02",
	distant: "04",
	greeting: "06",
};

const clipPath = (clip: string) => `motions/Hiyori_m${clip}.motion3.json`;
const knownPaths = new Set(Object.values(emotionClips).map(clipPath));

export function createHiyoriMotions(
	sdk: typeof Cubism,
	model: Cubism.Model,
	home: string,
	references: HiyoriMotionReferences | undefined,
	parent: AbortSignal,
) {
	const manager = new sdk.CubismMotionManager();
	const abort = new AbortController();
	const signal = AbortSignal.any([parent, abort.signal]);
	const clips = new Map<
		string,
		{ motion: Cubism.CubismMotion; fadeOut: number }
	>();
	const unique = new Map<string, MotionRef>();
	for (const ref of Object.values(references ?? {}).flat()) {
		if (knownPaths.has(ref.File)) unique.set(ref.File, ref);
	}
	for (const ref of unique.values()) {
		void (async () => {
			const response = await fetch(home + ref.File, { signal });
			if (!response.ok) return;
			const bytes = await response.arrayBuffer();
			signal.throwIfAborted();
			const motion = sdk.CubismMotion.create(
				bytes,
				bytes.byteLength,
				undefined,
				undefined,
				true,
			);
			if (!motion) return;
			// These clips animate eye parameters directly. Web Audio owns mouth opening.
			motion.setEffectIds([], []);
			const fadeOut = ref.FadeOutTime ?? 0.5;
			motion.setFadeInTime(ref.FadeInTime ?? 0.5);
			motion.setFadeOutTime(fadeOut);
			motion.setLoop(false);
			motion.setWeight(0.8);
			clips.set(ref.File, { motion, fadeOut });
		})().catch(() => {}); // Missing clips leave the face presets available.
	}

	let lastSelection: string | undefined;
	let active: { handle: object; key: string; fadeOut: number } | undefined;
	return {
		update(dt: number, cue?: AvatarCue | null) {
			const emotion = cue?.emotion;
			const clip =
				emotion && emotion !== "none"
					? emotionClips[emotion]
					: cue && motionClips[cue.motion];
			const key =
				cue && clip
					? `${cue.gestureKey ?? cue.key}:${emotion ?? cue.motion}`
					: undefined;
			if (active && active.key !== key) {
				manager
					.getCubismMotionQueueEntry(active.handle)
					?.setFadeOut(active.fadeOut);
				active = undefined;
			}
			const loaded = clip && clips.get(clipPath(clip));
			if (loaded && key && key !== lastSelection) {
				lastSelection = key;
				active = {
					key,
					handle: manager.startMotion(loaded.motion, false),
					fadeOut: loaded.fadeOut,
				};
			}
			manager.updateMotion(model, dt);
		},
		stop() {
			manager.stopAllMotions();
			active = undefined;
		},
		dispose() {
			abort.abort();
			manager.release();
			for (const { motion } of clips.values()) motion.release();
			clips.clear();
		},
	};
}
