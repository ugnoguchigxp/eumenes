import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";

/** The part of a screen's adapter that points at an item and plays it. */
type ScreenControl = Pick<WebArtifactAdapter, "focus" | "play">;

/** What the app provides for showing a resource: tabs and the screens' own controls. */
export type ResourceLauncher = {
	/** Opens (or fronts) the screen of the adapter on the target; false when the app has no such screen. */
	open(adapterRef: string, targetRef: string): Promise<boolean>;
	screen(adapterRef: string): ScreenControl | undefined;
};

type ScreenTarget = {
	adapterRef: string;
	targetRef: string;
	action: "open" | "play";
};

/**
 * How showing a resource ended: `blocked` when the browser refused to play without a user
 * gesture, `unavailable` when the screen or the item is not there (or cannot play).
 */
export type PresentOutcome = "done" | "blocked" | "unavailable";

const isPlaybackRefused = (error: unknown) =>
	error instanceof DOMException && error.name === "NotAllowedError";

/**
 * Opens the screen, points at the item, and for `play` starts it. The one place that sequence
 * lives, for a clicked link and for a command from the conversation alike.
 */
export async function presentOnScreen(
	launcher: ResourceLauncher,
	target: ScreenTarget,
): Promise<PresentOutcome> {
	try {
		if (!(await launcher.open(target.adapterRef, target.targetRef)))
			return "unavailable";
		const screen = launcher.screen(target.adapterRef);
		if (screen?.focus && !(await screen.focus(target.targetRef)))
			return "unavailable";
		if (target.action !== "play") return "done";
		if (!screen?.play) return "unavailable";
		await screen.play(target.targetRef);
		return "done";
	} catch (error) {
		return isPlaybackRefused(error) ? "blocked" : "unavailable";
	}
}
