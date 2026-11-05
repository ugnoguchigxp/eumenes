import type { Migration } from "../../../infrastructure/sqlite";

/**
 * The studio's drafts (spec task-pipeline-design 2026-10-22 §8.1, §13.6): one work per specialist session, its
 * canonical text and every revision it went through. Published pipelines live in capabilities, not here.
 */
export const migrations: readonly Migration[] = [
	{
		id: "pipelines/0001-works",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE pipeline_works (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, target_id TEXT,
 revision INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, previous_text TEXT NOT NULL,
 published_digest TEXT, busy_run_id TEXT, rejected_json TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE pipeline_work_versions (
 work_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
 origin TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (work_id, revision)
);
CREATE TABLE pipeline_receipts (
 id TEXT PRIMARY KEY, work_id TEXT NOT NULL, input_digest TEXT NOT NULL, receipt_json TEXT NOT NULL
);
CREATE TABLE pipeline_studio_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO pipeline_studio_revision (id, revision) VALUES (1, 0);
`,
	},
];
