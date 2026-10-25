import "./resource-focus.css";

/** How long a focused item stays marked. */
export const FOCUS_MARK_MS = 2_000;

/** Scrolls the element into view and marks it for `FOCUS_MARK_MS`. */
export function markResourceElement(element: HTMLElement) {
	element.scrollIntoView?.({ block: "center", behavior: "smooth" });
	element.setAttribute("data-resource-focus", "true");
	setTimeout(
		() => element.removeAttribute("data-resource-focus"),
		FOCUS_MARK_MS,
	);
}

/**
 * Marks the element `find` returns once the screen has drawn it (the screen may still be
 * rendering after a tab opened); false when it never appears.
 */
export async function focusWhenDrawn(
	find: () => HTMLElement | null,
	waitMs = 2_000,
): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const element = find();
		if (element) {
			markResourceElement(element);
			return true;
		}
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
