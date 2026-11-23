import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

/**
 * `steward/0009-sleep-pressure`: the deep consolidation also starts when the memory grew (the memory recall
 * implementation, section 5). `steward_sleep_state` keeps what the memory held when the last deep consolidation
 * finished: the active items and the pairs of similar records. NULL means that there is no baseline yet.
 */
export const sleepPressureMigration: Migration = {
	id: "steward/0009-sleep-pressure",
	after: ["steward/0008-target-requests"],
	sql: `
ALTER TABLE steward_sleep_state ADD COLUMN deep_item_count INTEGER;
ALTER TABLE steward_sleep_state ADD COLUMN deep_similar_pairs INTEGER;
`,
};

/** What the memory held at the last deep consolidation (or when the steward first looked). */
export interface SleepPressureBaseline {
	activeItems: number;
	similarPairs: number;
}

/** The baseline, or null while there is none (the first look writes it). */
export function readPressureBaseline(
	db: Database,
): SleepPressureBaseline | null {
	const row = db
		.query(
			"SELECT deep_item_count AS activeItems, deep_similar_pairs AS similarPairs FROM steward_sleep_state WHERE id = 1",
		)
		.get() as {
		activeItems: number | null;
		similarPairs: number | null;
	} | null;
	if (!row || row.activeItems === null || row.similarPairs === null)
		return null;
	return { activeItems: row.activeItems, similarPairs: row.similarPairs };
}

export function writePressureBaseline(
	db: Database,
	baseline: SleepPressureBaseline,
) {
	db.query(
		"UPDATE steward_sleep_state SET deep_item_count = ?, deep_similar_pairs = ? WHERE id = 1",
	).run(baseline.activeItems, baseline.similarPairs);
}
