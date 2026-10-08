import type { AvatarMotion } from "./model.js";
import { blendPose, neutral, sampleMotion, type Pose } from "./motion.js";

/** Speech continues for the actual playback duration and preserves Laya's motion. */
export function samplePerformancePose(
	motion: AvatarMotion,
	elapsed: number,
	speaking: boolean,
) {
	const time = Math.max(0, elapsed);
	const phraseTime = speaking ? time % 8 : time;
	const emotion = sampleMotion(motion, phraseTime);
	const pose = blendPose(neutral, emotion, 0.5);
	pose.open = emotion.open;
	if (speaking && motion !== "speaking") {
		const speech = sampleMotion("speaking", phraseTime);
		const weight =
			motion === "neutral"
				? 0.5
				: ["downcast", "shy", "sleepy"].includes(motion)
					? 0.2
					: 0.35;
		for (const key of Object.keys(neutral) as Array<keyof Pose>) {
			if (key !== "open") pose[key] += (speech[key] - neutral[key]) * weight;
		}
		if (motion === "neutral") pose.open = speech.open;
	}
	return pose;
}
