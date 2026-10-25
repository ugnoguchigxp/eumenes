/**
 * `steward/0004-drop-recall`: the automatic recall is gone (the ContextWindow layout specification, 2026-10-25).
 * Its units, requests and decisions are dropped, the `recall` slot leaves `steward_unit`, and `steward_state` loses
 * `recall_pending`.
 */
export const dropRecallMigration = `
DELETE FROM steward_request WHERE step = 'prepare-recall';
DELETE FROM steward_decision_ref WHERE decision_id IN (SELECT id FROM steward_decision WHERE step = 'prepare-recall');
DELETE FROM steward_decision WHERE step = 'prepare-recall';
CREATE TABLE steward_unit_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('events','requests','maintenance','world_events')),
 step TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('reflect','maintenance','world','episode')),
 targets TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, forget_seq INTEGER, window_version INTEGER,
 state TEXT NOT NULL CHECK(state IN ('open','applied','stale','failed')),
 job_id TEXT, created_at TEXT NOT NULL, closed_at TEXT
);
INSERT INTO steward_unit_next (id, conversation_id, kind, step, slot, targets, attempt, forget_seq, window_version, state,
 job_id, created_at, closed_at)
 SELECT id, conversation_id, kind, step, slot, targets, attempt, forget_seq, window_version, state, job_id, created_at,
 closed_at FROM steward_unit WHERE slot <> 'recall';
DROP TABLE steward_unit;
ALTER TABLE steward_unit_next RENAME TO steward_unit;
CREATE UNIQUE INDEX steward_unit_open ON steward_unit(conversation_id, slot) WHERE state = 'open';
CREATE INDEX steward_unit_conversation ON steward_unit(conversation_id, state);
ALTER TABLE steward_state DROP COLUMN recall_pending;
`;
