export {
	createAvatarPlayback,
	deliveryAvatarCue,
	type AvatarCue,
} from "./controller";
export {
	defaultAvatarView,
	readAvatarView,
	saveAvatarView,
	type AvatarView,
} from "./view";
/** The Live2D drawing area's `#rrggbb` colour (kept in the settings); null keeps the built-in gradient. */
export type AvatarBackground = string | null;

/** Keep the optional model code out of the other backgrounds' initial bundle. */
export async function createHiyori(host: HTMLElement, signal: AbortSignal) {
	const model = await import("./live2d/model");
	return model.createHiyori(host, signal);
}
