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

// While the motion lab is on screen the conversation background pauses, so only one spirit animates.
let labsOnScreen = 0;
const listeners = new Set<() => void>();
export function setMotionLabOnScreen(onScreen: boolean) {
	labsOnScreen = Math.max(0, labsOnScreen + (onScreen ? 1 : -1));
	for (const listener of listeners) listener();
}
export function subscribeMotionLab(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
export const motionLabOnScreen = () => labsOnScreen > 0;
