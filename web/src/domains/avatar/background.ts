/** The drawing area's colour; null keeps the built-in gradient. Never tints the model. */
export type AvatarBackground = string | null;

const storageKey = "eumenes.avatar.live2d-hiyori.background.v1";
const hexColor = /^#[0-9a-f]{6}$/i;

/** Restore only a `#rrggbb` colour saved in this browser. */
export function readAvatarBackground(): AvatarBackground {
	try {
		const saved = JSON.parse(
			window.localStorage.getItem(storageKey) ?? "null",
		) as { color?: unknown } | null;
		const color = saved?.color;
		return typeof color === "string" && hexColor.test(color)
			? color.toLowerCase()
			: null;
	} catch {
		return null;
	}
}

export function saveAvatarBackground(color: AvatarBackground): void {
	try {
		if (color === null) window.localStorage.removeItem(storageKey);
		else window.localStorage.setItem(storageKey, JSON.stringify({ color }));
	} catch {
		// Blocked or full browser storage must not interrupt drawing or conversation.
	}
}
