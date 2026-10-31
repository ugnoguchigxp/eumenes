import type { LarmPort } from "../../larm";
import type { ScreenDetails } from "../contracts/screen-presence";

type Tab = {
	revision: number;
	active: boolean;
	expiresAt: number;
	registeredAt: number;
	gestureAt: number;
	voiceSessionAt: number | null;
	leaving: boolean;
};

/**
 * Bounded, expiring tab ownership. A delayed notification cannot revive a departed tab.
 * One screen plays sound (spec tts-single-lane §4.2): the one holding the voice session (the latest
 * opened), else the one the user touched last, else the latest registered. A hidden screen keeps it.
 */
export function createScreenPresence(
	getPort: () => Pick<LarmPort, "retain">,
	subscribeSettings: (changed: () => void) => () => void,
	/** Told when another screen (or none) becomes the one that plays sound; each screen then asks again. */
	playbackChanged: () => void = () => {},
) {
	const tabs = new Map<string, Tab>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let current: Pick<LarmPort, "retain"> | undefined;
	let closed = false;
	let playing: string | null = null;
	/** Told when a conversation screen comes to be shown after none was. */
	const shown = new Set<() => void>();
	function playbackScreen(): string | null {
		let best: [string, Tab] | undefined;
		const rank = (tab: Tab) =>
			[tab.voiceSessionAt ?? -1, tab.gestureAt, tab.registeredAt] as const;
		for (const entry of tabs) {
			if (entry[1].leaving) continue;
			if (!best) {
				best = entry;
				continue;
			}
			const [a, b] = [rank(entry[1]), rank(best[1])];
			const later = a.findIndex((value, i) => value !== b[i]);
			if (later >= 0 && a[later]! > b[later]!) best = entry;
		}
		return best?.[0] ?? null;
	}
	function sync() {
		clearTimeout(timer);
		for (const [id, tab] of tabs)
			if (tab.expiresAt <= Date.now()) tabs.delete(id);
		const next = [...tabs.values()].some((tab) => tab.active)
			? getPort()
			: undefined;
		if (next !== current) {
			const appeared = !current && !!next;
			current?.retain?.(false);
			current = next;
			current?.retain?.(true);
			if (appeared) for (const listener of shown) listener();
		}
		const player = playbackScreen();
		if (player !== playing) {
			playing = player;
			playbackChanged();
		}
		if (tabs.size) {
			const deadline = Math.min(
				...[...tabs.values()].map((tab) => tab.expiresAt),
			);
			timer = setTimeout(sync, Math.max(0, deadline - Date.now()));
			timer.unref?.();
		}
	}
	const unsubscribe = subscribeSettings(sync);
	return {
		/** Records the screen's report and says whether it is the screen that plays sound. */
		update(
			id: string,
			revision: number,
			active: boolean,
			sentAt: number,
			details: ScreenDetails = {},
		): boolean {
			if (closed) throw new Error("inference_closed");
			if (sentAt <= Date.now() - 90_000 || sentAt > Date.now() + 5000)
				throw new Error("screen_presence_expired");
			sync();
			const previous = tabs.get(id);
			if (previous && revision <= previous.revision) return playing === id;
			if (!previous && tabs.size >= 64)
				throw new Error("screen_presence_capacity");
			// Turned into this server's clock: devices' clocks differ, their elapsed times do not.
			const gestureAt =
				details.gestureAgeMs === undefined
					? 0
					: Date.now() - details.gestureAgeMs;
			tabs.set(id, {
				revision,
				active,
				expiresAt: sentAt + 90_000,
				registeredAt: previous?.registeredAt ?? Date.now(),
				gestureAt: Math.max(previous?.gestureAt ?? 0, gestureAt),
				voiceSessionAt: details.voiceSession
					? (previous?.voiceSessionAt ?? Date.now())
					: null,
				leaving: !!details.leaving,
			});
			sync();
			return playing === id;
		},
		/** Whether this screen is the one that plays sound now. */
		isPlaybackScreen: (id: string) => {
			sync();
			return playing === id;
		},
		/** Whether a conversation screen is shown now. */
		present: () => {
			sync();
			return current !== undefined;
		},
		/** Told when a conversation screen comes to be shown after none was. Returns the unsubscribe function. */
		onShown(listener: () => void) {
			shown.add(listener);
			return () => {
				shown.delete(listener);
			};
		},
		close() {
			closed = true;
			unsubscribe();
			tabs.clear();
			sync();
		},
	};
}
export type ScreenPresence = ReturnType<typeof createScreenPresence>;
/** The inference service's screen operations. */
export const screenOperations = (screen: ScreenPresence) => ({
	screenPresence: screen.update,
	isPlaybackScreen: screen.isPlaybackScreen,
	screenPresent: screen.present,
	onScreenShown: screen.onShown,
});
