import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "codex-tasks/0001-attempts",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE codex_task_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 0, runner_id TEXT, workspace_id TEXT, resource_id TEXT
);
INSERT INTO codex_task_settings(id) VALUES(1);
CREATE TABLE codex_task_settings_receipts(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt_json TEXT NOT NULL);
CREATE TABLE codex_task_attempts (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, card_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
 request_id TEXT NOT NULL UNIQUE, spec_json TEXT NOT NULL, input_digest TEXT NOT NULL,
 worker_revision TEXT NOT NULL, settings_revision INTEGER NOT NULL, runner_id TEXT NOT NULL,
 executor_revision INTEGER NOT NULL, workspace_ref TEXT NOT NULL, guard_epoch TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('accepted','starting','running','settling','stopping','succeeded','blocked','failed','cancelled','unknown')),
 published INTEGER NOT NULL DEFAULT 0, epoch TEXT, event_seq INTEGER NOT NULL DEFAULT 0,
 receipt_json TEXT, adopted INTEGER NOT NULL DEFAULT 0, stop_requested INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE codex_task_events (
 attempt_id TEXT NOT NULL REFERENCES codex_task_attempts(id), seq INTEGER NOT NULL,
 event_json TEXT NOT NULL, PRIMARY KEY(attempt_id,seq)
);
CREATE INDEX codex_task_pending ON codex_task_attempts(adopted,created_at,id);
`,
	},
];
