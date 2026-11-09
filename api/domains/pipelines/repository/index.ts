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
	{
		id: "pipelines/0002-workflow-definitions",
		after: ["pipelines/0001-works"],
		sql: `
CREATE TABLE workflow_definition_revisions (
 scope TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
 digest TEXT NOT NULL, value_json TEXT NOT NULL,
 PRIMARY KEY (scope, workflow_id, revision)
);
CREATE TABLE workflow_save_receipts (
 scope TEXT NOT NULL, operation_id TEXT NOT NULL, input_digest TEXT NOT NULL,
 workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
 PRIMARY KEY (scope, operation_id),
 FOREIGN KEY (scope, workflow_id, revision) REFERENCES workflow_definition_revisions(scope, workflow_id, revision)
);
`,
	},
	{
		id: "pipelines/0003-workflow-runs",
		after: ["pipelines/0002-workflow-definitions"],
		sql: `
CREATE TABLE workflow_runs (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, workflow_id TEXT NOT NULL, definition_revision INTEGER NOT NULL,
 origin TEXT NOT NULL, operation_id TEXT NOT NULL, input_digest TEXT NOT NULL,
 inputs_json TEXT NOT NULL, state TEXT NOT NULL, lock_key TEXT, deadline INTEGER NOT NULL,
 scheduled_at INTEGER, parent_id TEXT, job_id TEXT, version INTEGER NOT NULL,
 UNIQUE(scope, origin, operation_id), UNIQUE(scope, workflow_id, lock_key),
 FOREIGN KEY (scope, workflow_id, definition_revision) REFERENCES workflow_definition_revisions(scope, workflow_id, revision)
);`,
	},

	{
		id: "pipelines/0004-workflow-progress",
		after: ["pipelines/0003-workflow-runs"],
		sql: `
ALTER TABLE workflow_runs ADD COLUMN result_json TEXT;
ALTER TABLE workflow_runs ADD COLUMN publication_json TEXT;
CREATE INDEX workflow_runs_recent ON workflow_runs(scope,workflow_id,definition_revision);
CREATE TABLE workflow_schedules (
 scope TEXT NOT NULL, workflow_id TEXT NOT NULL, definition_revision INTEGER NOT NULL,
 schedule_id TEXT NOT NULL UNIQUE, active INTEGER NOT NULL,
 PRIMARY KEY(scope,workflow_id,schedule_id)
);
CREATE UNIQUE INDEX workflow_active_schedule ON workflow_schedules(scope,workflow_id) WHERE active=1;
CREATE TABLE workflow_checkpoints (
 scope TEXT NOT NULL, workflow_id TEXT NOT NULL, compatibility TEXT NOT NULL,
 unit_key TEXT NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(scope,workflow_id,compatibility,unit_key)
);`,
	},
];
