import type { AgencyActivity } from "../../domains/dialogue/contracts/agency-status";

/** Finite screen leases are state contracts, never an interpretation of input text. */
export function createAgencyActivity(input: {
	now(): number;
	changed(): void;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}) {
	const screens = new Map<
		string,
		{ conversationId: string; activity: AgencyActivity; expiresAt: number }
	>();
	let timer: unknown;
	function expire() {
		for (const [id, row] of screens)
			if (row.expiresAt <= input.now()) screens.delete(id);
	}
	function rearm() {
		if (timer !== undefined) input.clearTimer(timer);
		const times = [...screens.values()].map((row) => row.expiresAt);
		timer = times.length
			? input.setTimer(
					() => {
						expire();
						input.changed();
						rearm();
					},
					Math.max(0, Math.min(...times) - input.now()),
				)
			: undefined;
	}
	return {
		update(conversationId: string, activity: AgencyActivity) {
			expire();
			if (
				activity.sentAt < input.now() - 90_000 ||
				activity.sentAt > input.now() + 5_000
			)
				return false;
			const previous = screens.get(activity.screenId);
			if (previous && previous.activity.revision >= activity.revision)
				return false;
			if (!previous && screens.size >= 64)
				throw new Error("agency_activity_capacity");
			screens.set(activity.screenId, {
				conversationId,
				activity: { ...activity },
				expiresAt: input.now() + 45_000,
			});
			input.changed();
			rearm();
			return true;
		},
		busy(conversationId: string) {
			expire();
			return [...screens.values()].some(
				(s) =>
					s.conversationId === conversationId &&
					!s.activity.leaving &&
					(s.activity.playing || (s.activity.visible && s.activity.typing)),
			);
		},
		close() {
			if (timer !== undefined) input.clearTimer(timer);
			screens.clear();
		},
	};
}
