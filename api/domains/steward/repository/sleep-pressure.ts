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
