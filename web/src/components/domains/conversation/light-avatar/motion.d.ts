import type { AvatarMotion } from "./model.js";
export type Pose = Record<
	| "hx"
	| "hy"
	| "hz"
	| "bx"
	| "by"
	| "bz"
	| "lift"
	| "forward"
	| "left"
	| "right"
	| "leftInner"
	| "rightInner"
	| "gx"
	| "gy"
	| "energy"
	| "open",
	number
>;
export const neutral: Pose;
export function sampleMotion(mode: AvatarMotion, time: number): Pose;
export function blendPose(a: Pose, b: Pose, weight: number): Pose;
