import type { AgendaScope } from "./always-on-scope";

/** How long a started assignment's screen stays in the status for the Web to open. */
const SCREEN_SIGNAL_MS = 10 * 60_000;
type Screen = { assignment: string; adapterRef: string; at: number };
/** The screens of the assignments each conversation started lately (not saved: a restart opens nothing new). */
const screens = new WeakMap<AgendaScope, Screen[]>();

/** The assignment started (its toolchain took the work): its registered screen is told to the Web, once. */
export function openScreen(c: AgendaScope, screen: Screen) {
	const list = screens.get(c) ?? [];
	if (!list.some((s) => s.assignment === screen.assignment))
		screens.set(c, [...list, screen]);
}

/** The screens the Web may still open: the newest eight of the last ten minutes (kept after the work ends). */
export function recentScreens(c: AgendaScope, at: number) {
	const kept = (screens.get(c) ?? [])
		.filter((s) => at - s.at < SCREEN_SIGNAL_MS)
		.slice(-8);
	screens.set(c, kept);
	return kept;
}
