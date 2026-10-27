import type { Migration } from "../../../infrastructure/sqlite";

/** Activity reads look up each unit's job and the newest closed unit in its slot. */
export const activityIndexesMigration: Migration = {
	id: "steward/0006-activity-indexes",
	after: ["steward/0005-drop-episode"],
	sql: `
CREATE INDEX steward_decision_job ON steward_decision(conversation_id, job_id);
CREATE INDEX steward_unit_last_closed ON steward_unit(conversation_id, slot, closed_at)
 WHERE state <> 'open' AND closed_at IS NOT NULL;
`,
};
