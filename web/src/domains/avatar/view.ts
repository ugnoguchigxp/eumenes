/** Position offsets are fractions of the viewport; positive values move right/down. */
export type AvatarView = Readonly<{ zoom: number; x: number; y: number }>;
export const defaultAvatarView: AvatarView = { zoom: 1, x: 0, y: 0 };

const storageKey = "eumenes.avatar.live2d-hiyori.view.v1";

/** Restore only the three finite, in-range viewport values from this browser. */
export function readAvatarView(): AvatarView {
	try {
		const saved = JSON.parse(
			window.localStorage.getItem(storageKey) ?? "null",
		) as Partial<AvatarView> | null;
		if (
			!saved ||
			typeof saved.zoom !== "number" ||
			!Number.isFinite(saved.zoom) ||
			saved.zoom < 0.5 ||
			saved.zoom > 3 ||
			typeof saved.x !== "number" ||
			!Number.isFinite(saved.x) ||
			Math.abs(saved.x) > 0.5 ||
			typeof saved.y !== "number" ||
			!Number.isFinite(saved.y) ||
			Math.abs(saved.y) > 0.5
		)
			return defaultAvatarView;
		return { zoom: saved.zoom, x: saved.x, y: saved.y };
	} catch {
		return defaultAvatarView;
	}
}

export function saveAvatarView(view: AvatarView): void {
	try {
		window.localStorage.setItem(storageKey, JSON.stringify(view));
	} catch {
		// Blocked or full browser storage must not interrupt framing or conversation.
	}
}
