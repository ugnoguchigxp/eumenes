import type { Motion, motionGroups as groups } from "./clips";
import type { AvatarLayers, MotionChoice } from "./performer";

export const motions: readonly Motion[];
export const motionGroups: typeof groups;

export type AvatarMotion =
	| "neutral"
	| "listening"
	| "thinking"
	| "speaking"
	| "curious"
	| "distant"
	| "downcast"
	| "greeting"
	| "agreeing"
	| "joyful"
	| "surprised"
	| "shy"
	| "sleepy";
export interface LightAvatar {
	canvas: HTMLCanvasElement;
	resize(): void;
	/** `motion` is any registered motion id (the lab also plays idle gestures); unknown ids act as neutral. */
	render(
		time?: number,
		motion?: AvatarMotion | (string & {}),
		elapsed?: number,
		speaking?: boolean,
	): void;
	/** Starts a new cue; without a choice the variant and ±10% rate are picked automatically. */
	beginMotion(choice?: MotionChoice): void;
	setLayers(layers: Partial<AvatarLayers>): void;
	showSkeleton(visible: boolean): void;
	dispose(): void;
	/** Diagnostics for tests and the motion lab (motion, variant, spin, draw calls, ...). */
	stats(): Record<string, string | number | boolean | null>;
}
export function createLightAvatar(host: HTMLElement): LightAvatar;
