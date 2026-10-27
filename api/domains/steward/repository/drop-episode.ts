/**
 * `steward/0005-drop-episode`: the episode preparation is gone (the conversation input specification, 2026-10-26,
 * section 12). Its units and decisions are dropped, the `episode` slot and `window_version` leave `steward_unit`,
 * and the ranges the preparation gave up leave the upkeep control.
 */
export const dropEpisodeMigration = `
DELETE FROM steward_decision_ref WHERE decision_id IN
 (SELECT id FROM steward_decision WHERE step IN ('summarize','refine-summary'));
DELETE FROM steward_decision WHERE step IN ('summarize','refine-summary');
CREATE TABLE steward_unit_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('events','requests','maintenance','world_events')),
 step TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('reflect','maintenance','world')),
 targets TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, forget_seq INTEGER,
 state TEXT NOT NULL CHECK(state IN ('open','applied','stale','failed')),
 job_id TEXT, created_at TEXT NOT NULL, closed_at TEXT
);
INSERT INTO steward_unit_next (id, conversation_id, kind, step, slot, targets, attempt, forget_seq, state, job_id,
 created_at, closed_at)
 SELECT id, conversation_id, kind, step, slot, targets, attempt, forget_seq, state, job_id, created_at, closed_at
 FROM steward_unit WHERE slot <> 'episode' AND step NOT IN ('summarize','refine-summary');
DROP TABLE steward_unit;
ALTER TABLE steward_unit_next RENAME TO steward_unit;
CREATE UNIQUE INDEX steward_unit_open ON steward_unit(conversation_id, slot) WHERE state = 'open';
CREATE INDEX steward_unit_conversation ON steward_unit(conversation_id, state);
UPDATE steward_state SET quiet_steps = json_remove(quiet_steps, '$.episode');
`;
