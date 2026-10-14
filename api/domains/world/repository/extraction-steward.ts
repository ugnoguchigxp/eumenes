/**
 * Append-only host migration (the steward drives extraction now, there is no queue job).
 *
 * - `speaker` / `conversation_id` are fixed when the event is received: the steward groups pending
 *   events by conversation and the origin check of a claim needs the speaker. An event received
 *   before this migration keeps the speaker `user` (only user input existed) and has no
 *   conversation: it is never listed for the steward, because history is not backfilled.
 * - the job columns (`job_id`, `request_id`) and the backoff columns (`failures`, `retry_at_ms`)
 *   belonged to the retired `world.extract` job and are dropped.
 */
export const extractionStewardMigration = `
ALTER TABLE world_host_extract_event
ADD COLUMN speaker TEXT NOT NULL DEFAULT 'user' CHECK (speaker IN ('user', 'assistant'));
ALTER TABLE world_host_extract_event
ADD COLUMN conversation_id TEXT CHECK (conversation_id IS NULL OR length(conversation_id) BETWEEN 1 AND 200);
ALTER TABLE world_host_extract_event DROP COLUMN job_id;
ALTER TABLE world_host_extract_event DROP COLUMN request_id;
ALTER TABLE world_host_extract_event DROP COLUMN failures;
ALTER TABLE world_host_extract_event DROP COLUMN retry_at_ms;
`;

/**
 * Append-only host migration: a forget the steward asks for (it blocked a message, or the person
 * asked to forget a claim or a target) has its own origin. The table is rebuilt because SQLite
 * cannot change a CHECK.
 */
export const forgetOriginMigration = `
CREATE TABLE world_host_forget_intake_next (
	forget_id TEXT PRIMARY KEY CHECK (length(forget_id) BETWEEN 1 AND 200),
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	memory_forget_id TEXT CHECK (memory_forget_id IS NULL OR length(memory_forget_id) BETWEEN 1 AND 200),
	memory_final INTEGER NOT NULL DEFAULT 1 CHECK (memory_final IN (0, 1)),
	reason_code TEXT NOT NULL CHECK (reason_code IN ('FORGET_REQUESTED', 'SOURCE_FORGOTTEN', 'CORRECTION_APPLIED', 'AUTHORIZATION_REVOKED')),
	origin TEXT NOT NULL CHECK (origin IN ('request', 'memory_feed', 'source_feed', 'restored', 'steward')),
	roots_json TEXT NOT NULL,
	roots_digest TEXT NOT NULL CHECK (length(roots_digest) = 64),
	state TEXT NOT NULL CHECK (state IN ('pending', 'journaled', 'world_applied', 'memory_confirmed', 'complete')),
	journal_seq INTEGER,
	journal_hash TEXT,
	world_part INTEGER NOT NULL DEFAULT 0 CHECK (world_part >= 0),
	world_chunks INTEGER NOT NULL DEFAULT 0 CHECK (world_chunks >= 0),
	blocked_reason TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK ((journal_seq IS NULL) = (journal_hash IS NULL))
);
INSERT INTO world_host_forget_intake_next
	(forget_id, principal, scope_key, memory_forget_id, memory_final, reason_code, origin, roots_json, roots_digest, state, journal_seq, journal_hash, world_part, world_chunks, blocked_reason, created_at, updated_at)
SELECT forget_id, principal, scope_key, memory_forget_id, memory_final, reason_code, origin, roots_json, roots_digest, state, journal_seq, journal_hash, world_part, world_chunks, blocked_reason, created_at, updated_at
FROM world_host_forget_intake;
DROP TABLE world_host_forget_intake;
ALTER TABLE world_host_forget_intake_next RENAME TO world_host_forget_intake;
CREATE INDEX world_host_forget_intake_open ON world_host_forget_intake (state) WHERE state <> 'complete';
CREATE INDEX world_host_forget_intake_memory ON world_host_forget_intake (memory_forget_id) WHERE memory_forget_id IS NOT NULL;
`;
