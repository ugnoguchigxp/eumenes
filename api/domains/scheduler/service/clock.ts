/** Pure due-time arithmetic. All values are UTC epoch milliseconds. */

export function firstBoundaryAtOrAfter(
	anchor: number,
	interval: number,
	t: number,
): number {
	if (t <= anchor) return anchor;
	return anchor + Math.ceil((t - anchor) / interval) * interval;
}
export function firstBoundaryAfter(
	anchor: number,
	interval: number,
	t: number,
): number {
	if (t < anchor) return anchor;
	return anchor + (Math.floor((t - anchor) / interval) + 1) * interval;
}

export interface DueSchedule {
	mode: "once" | "interval";
	anchorAtMs: number;
	intervalMs: number | null;
	nextDueAtMs: number;
}
export interface FirePlan {
	/** The occurrence time to record (the newest elapsed one for interval schedules). */
	scheduledAtMs: number;
	/** Earlier elapsed occurrences folded into this one. */
	missed: number;
	lateMs: number;
	/** Next due time, or null when a one-shot schedule is finished. */
	nextDueAtMs: number | null;
}

/** Plan a single catch-up occurrence; never loops over elapsed periods. */
export function planFire(s: DueSchedule, now: number): FirePlan {
	if (s.mode === "once" || s.intervalMs === null)
		return {
			scheduledAtMs: s.nextDueAtMs,
			missed: 0,
			lateMs: Math.max(0, now - s.nextDueAtMs),
			nextDueAtMs: null,
		};
	const steps = Math.max(0, Math.floor((now - s.nextDueAtMs) / s.intervalMs));
	const scheduledAtMs = s.nextDueAtMs + steps * s.intervalMs;
	return {
		scheduledAtMs,
		missed: steps,
		lateMs: now - scheduledAtMs,
		nextDueAtMs: scheduledAtMs + s.intervalMs,
	};
}
