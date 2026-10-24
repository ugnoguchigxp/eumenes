/**
 * The SQL of retired tables, kept as it was applied: the migration history replays it on a fresh database before
 * `dialogue/0019-retire-continuations` drops the tables (continuation runs and retained toolchain references were
 * replaced by the TODO ledger).
 */
export const retainedToolchainsMigration = `
CREATE TABLE dialogue_toolchain_state (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
 epoch INTEGER NOT NULL DEFAULT 0, last_use_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE dialogue_retained_toolchains (
 conversation_id TEXT NOT NULL REFERENCES conversations(id), revision_id TEXT NOT NULL,
 source_run_id TEXT NOT NULL REFERENCES dialogue_runs(id), selection_id TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id), source_revision TEXT NOT NULL,
 use_seq INTEGER NOT NULL, PRIMARY KEY(conversation_id, revision_id)
);
`;
export const continuationsMigration = `
CREATE TABLE dialogue_continuations (
 run_id TEXT PRIMARY KEY,
 root_run_id TEXT NOT NULL,
 hop INTEGER NOT NULL,
 original_request TEXT NOT NULL,
 achieved TEXT NOT NULL,
 need TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX dialogue_continuations_root ON dialogue_continuations(root_run_id, hop);`;
export const continuationConditionsMigration =
	"ALTER TABLE dialogue_continuations ADD COLUMN conditions_json TEXT NOT NULL DEFAULT '[]';";
export const continuationStepsMigration =
	"ALTER TABLE dialogue_continuations ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]';";
export const retireContinuationsMigration = `
DROP TABLE IF EXISTS dialogue_continuations;
DROP TABLE IF EXISTS dialogue_retained_toolchains;
DROP TABLE IF EXISTS dialogue_toolchain_state;
UPDATE dialogue_runs SET source_kind = 'notice' WHERE source_kind = 'continuation';`;
