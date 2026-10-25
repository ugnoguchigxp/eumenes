import type { LarmPort } from "../../larm";

/** Bounded, expiring tab ownership. A delayed notification cannot revive a departed tab. */
export function createScreenPresence(
	getPort: () => Pick<LarmPort, "retain">,
	subscribeSettings: (changed: () => void) => () => void,
) {
	const tabs = new Map<
		string,
		{ revision: number; active: boolean; expiresAt: number }
	>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let current: Pick<LarmPort, "retain"> | undefined;
	let closed = false;
	/** Told when a conversation screen comes to be shown after none was. */
	const shown = new Set<() => void>();
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
		update(id: string, revision: number, active: boolean, sentAt: number) {
			if (closed) throw new Error("inference_closed");
			if (sentAt <= Date.now() - 90_000 || sentAt > Date.now() + 5000)
				throw new Error("screen_presence_expired");
			sync();
			const previous = tabs.get(id);
			if (previous && revision <= previous.revision) return;
			if (!previous && tabs.size >= 64)
				throw new Error("screen_presence_capacity");
			tabs.set(id, { revision, active, expiresAt: sentAt + 90_000 });
			sync();
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
