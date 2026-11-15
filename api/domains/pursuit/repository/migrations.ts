import type { Migration } from "../../../infrastructure/sqlite";
import coreMigrations from "./core-migrations.json";

// Preserve the exact bytes of deployed migrations for existing databases.
export const migrations: readonly Migration[] = [
	...coreMigrations,
	{
		id: "pursuit/0001-host",
		after: ["queue/0001-init", "pursuit-core/0008"],
		sql: `
CREATE TABLE pursuit_runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state TEXT NOT NULL,
 epoch INTEGER NOT NULL, revision INTEGER NOT NULL, deadline INTEGER NOT NULL,
 step INTEGER NOT NULL, core_id TEXT, data_json TEXT, job_id TEXT,
 active_request TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX pursuit_runs_active ON pursuit_runs(state, deadline);
CREATE TABLE pursuit_web_operations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pursuit_runs(id), epoch INTEGER NOT NULL,
 attempt_id TEXT NOT NULL UNIQUE, external_id TEXT NOT NULL, job_id TEXT NOT NULL,
 outcome_json TEXT, adopted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pursuit_documents (
 run_id TEXT NOT NULL REFERENCES pursuit_runs(id), epoch INTEGER NOT NULL, id TEXT NOT NULL,
 url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, fetched_at TEXT NOT NULL,
 truncated INTEGER NOT NULL, PRIMARY KEY (run_id, epoch, id)
);
CREATE TABLE pursuit_notices (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pursuit_runs(id), epoch INTEGER NOT NULL,
 ordinal INTEGER NOT NULL, state TEXT NOT NULL, UNIQUE (run_id, epoch, ordinal)
);
`,
	},
];
