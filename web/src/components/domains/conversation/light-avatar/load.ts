type ModelModule = typeof import("./model.js");
let modulePromise: Promise<ModelModule> | null = null;
/** One shared, retryable import of the three.js renderer chunk. */
export function loadLightAvatar() {
	modulePromise ??= import("./model.js").catch((error: unknown) => {
		modulePromise = null;
		throw error;
	});
	return modulePromise;
}
export const lightAvatarLoaded = () => modulePromise !== null;

// The conversation background owns the one spirit. While the settings motion lab is on
// screen, the background pauses its own playback and the lab drives the same model.
type Listener = () => void;
const listeners = new Set<Listener>();
const notify = () => {
	for (const listener of listeners) listener();
};
export function subscribeLightAvatar(listener: Listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
let labsOnScreen = 0;
export function setMotionLabOnScreen(onScreen: boolean) {
	labsOnScreen = Math.max(0, labsOnScreen + (onScreen ? 1 : -1));
	notify();
}
export const motionLabOnScreen = () => labsOnScreen > 0;
let backgroundModel: import("./model.js").LightAvatar | null = null;
/** Set by the background when its model is ready, cleared when it releases it. */
export function setBackgroundAvatar(
	model: import("./model.js").LightAvatar | null,
) {
	backgroundModel = model;
	notify();
}
export const backgroundAvatar = () => backgroundModel;
