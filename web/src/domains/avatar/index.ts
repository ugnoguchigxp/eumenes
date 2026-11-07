export { createAvatarPlayback, type AvatarCue } from "./controller";
export {
	defaultAvatarView,
	readAvatarView,
	saveAvatarView,
	type AvatarView,
} from "./view";

/** Keep the optional model code out of the other backgrounds' initial bundle. */
export async function createHiyori(host: HTMLElement, signal: AbortSignal) {
	const model = await import("./live2d/model");
	return model.createHiyori(host, signal);
}
