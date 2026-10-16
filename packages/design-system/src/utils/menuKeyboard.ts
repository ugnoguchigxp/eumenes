import type { KeyboardEvent } from "react";

const MENU_ITEMS = '[role="menuitem"]:not(:disabled)';

/** Arrow, Home and End move focus between the enabled menu items inside the menu. */
export function menuKeyDown(event: KeyboardEvent<HTMLElement>): void {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	const items = [
		...event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEMS),
	];
	if (items.length === 0) return;
	event.preventDefault();
	const current = items.indexOf(document.activeElement as HTMLElement);
	const last = items.length - 1;
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? last
				: event.key === "ArrowDown"
					? current < last
						? current + 1
						: 0
					: current > 0
						? current - 1
						: last;
	items[next]?.focus();
}
