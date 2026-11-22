import { jstDay, jstIso } from "../../../../infrastructure/jst-time";

/**
 * When the sleep layer starts (the memory redesign, section 6.1). The thresholds are first hypotheses: nothing
 * in the research settles them, and the evaluation of the cases will tune them. They live here and nowhere else.
 */
export const SLEEP_POLICY = {
	/** Shallow consolidation: open candidates (L1) written since the last shallow run. */
	shallowCandidates: 10,
	/** Deep consolidation in the time window: events (of all conversations) since the last deep run. */
	deepEvents: 20,
	/** Deep consolidation without the time window ("supplement"): events since the last deep run. */
	supplementEvents: 200,
	/** Shallow consolidation reads at most this many events' turns to embed in one unit. */
	embedEventsPerUnit: 32,
	/** The closure delete takes at most this many excluded forgets in one unit. */
	forgetsPerUnit: 8,
} as const;

/** The time window deep consolidation is pulled into, as `HH:MM` in Asia/Tokyo (a saved setting, 3:00-5:00 by default). */
export interface SleepWindow {
	start: string;
	end: string;
}

const minutesOf = (time: string): number => {
	const [h, m] = time.split(":");
	return Number(h) * 60 + Number(m);
};

/** The minute of the Asia/Tokyo day (0-1439) of an instant. */
export function jstMinuteOfDay(ms: number): number {
	const time = jstIso(ms).slice(11, 16);
	return minutesOf(time);
}

/**
 * Whether the instant is inside the window. A window whose end is not after its start runs past midnight
 * (22:00-02:00); an equal start and end is the whole day.
 */
export function inSleepWindow(ms: number, window: SleepWindow): boolean {
	const now = jstMinuteOfDay(ms);
	const start = minutesOf(window.start);
	const end = minutesOf(window.end);
	if (start === end) return true;
	return start < end ? now >= start && now < end : now >= start || now < end;
}

/** The user's local time as `YYYY-MM-DDTHH:MM` (what the plans' due check reads). */
export const localNow = (ms: number): string => jstIso(ms).slice(0, 16);
export { jstDay };
