import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "browser/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE browser_settings (
 key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE browser_connections (
 id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL, connected_at INTEGER,
 ended_at INTEGER, end_reason TEXT, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE INDEX browser_connections_state ON browser_connections(state);
CREATE TABLE browser_tabs (
 tab_ref TEXT PRIMARY KEY, connection_id TEXT NOT NULL, mcp_index INTEGER NOT NULL,
 url TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 0,
 generation INTEGER NOT NULL DEFAULT 0, observation_ref TEXT,
 lease_holder TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
 revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX browser_tabs_connection ON browser_tabs(connection_id, status);
CREATE TABLE browser_observations (
 ref TEXT PRIMARY KEY, tab_ref TEXT NOT NULL, generation INTEGER NOT NULL, task_id TEXT,
 refs_json TEXT NOT NULL, truncated INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX browser_observations_tab ON browser_observations(tab_ref);
CREATE TABLE browser_tasks (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, origin TEXT NOT NULL,
 request_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, tab_ref TEXT, start_url TEXT,
 frozen_json TEXT, core_state_json TEXT, state TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
 step INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL, result_text TEXT, error_code TEXT,
 announced INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX browser_tasks_owner ON browser_tasks(owner, created_at);
CREATE TABLE browser_operations (
 id TEXT PRIMARY KEY, task_id TEXT, tab_ref TEXT NOT NULL, tool_kind TEXT NOT NULL,
 input_digest TEXT NOT NULL, observation_ref TEXT, generation INTEGER NOT NULL,
 state TEXT NOT NULL, error_code TEXT, result_url TEXT, result_title TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX browser_operations_task ON browser_operations(task_id, created_at);
CREATE INDEX browser_operations_state ON browser_operations(state);
CREATE TABLE browser_input_grants (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, origin TEXT NOT NULL, purpose TEXT NOT NULL,
 provenance TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
 used_count INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX browser_input_grants_task ON browser_input_grants(task_id);
CREATE TABLE browser_captures (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, origin TEXT NOT NULL,
 request_id TEXT NOT NULL UNIQUE, task_id TEXT, tab_ref TEXT NOT NULL, range TEXT NOT NULL,
 element_ref TEXT, observation_ref TEXT, state TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
 step INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL,
 planned_width INTEGER, planned_height INTEGER, png_width INTEGER, png_height INTEGER, png_bytes INTEGER,
 temp_ref TEXT, webp_ref TEXT, webp_sha256 TEXT, webp_bytes INTEGER, reduction_percent REAL,
 error_code TEXT, announced INTEGER NOT NULL DEFAULT 0, captured_at INTEGER,
 revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX browser_captures_owner ON browser_captures(owner, created_at);
`,
	},
	{
		id: "browser/0002-approvals",
		after: ["browser/0001-init"],
		sql: `
CREATE TABLE browser_approvals (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, task_id TEXT NOT NULL,
 kind TEXT NOT NULL, tab_ref TEXT NOT NULL, url TEXT NOT NULL, action TEXT NOT NULL, element TEXT NOT NULL,
 value_digest TEXT, value TEXT, summary TEXT NOT NULL, grant_ref TEXT, status TEXT NOT NULL,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX browser_approvals_task ON browser_approvals(task_id, status);
CREATE TABLE browser_input_grants_next (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, origin TEXT NOT NULL, purpose TEXT NOT NULL,
 provenance TEXT NOT NULL, value TEXT, expires_at INTEGER NOT NULL,
 used_count INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, created_at INTEGER NOT NULL
);
INSERT INTO browser_input_grants_next SELECT * FROM browser_input_grants;
DROP TABLE browser_input_grants;
ALTER TABLE browser_input_grants_next RENAME TO browser_input_grants;
CREATE INDEX browser_input_grants_task ON browser_input_grants(task_id);
`,
	},
	{
		id: "browser/0003-scripts",
		after: ["browser/0002-approvals"],
		sql: `ALTER TABLE browser_tasks ADD COLUMN script_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_tasks ADD COLUMN script_json TEXT;
ALTER TABLE browser_tasks ADD COLUMN continued_from TEXT;
ALTER TABLE browser_operations ADD COLUMN script_revision INTEGER;
ALTER TABLE browser_operations ADD COLUMN script_step_id TEXT;
ALTER TABLE browser_connections ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_captures ADD COLUMN script_revision INTEGER;
ALTER TABLE browser_captures ADD COLUMN script_step_id TEXT;`,
	},
	{
		id: "browser/0004-progress",
		after: ["browser/0003-scripts"],
		sql: `ALTER TABLE browser_tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'preparing';
 CREATE INDEX browser_tasks_conversation ON browser_tasks(owner,conversation_id,created_at);`,
	},
	{
		id: "browser/0005-histories",
		after: ["browser/0004-progress"],
		sql: `CREATE TABLE browser_histories (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, request TEXT NOT NULL, place TEXT NOT NULL,
 variables_json TEXT NOT NULL, steps_json TEXT NOT NULL, actions_json TEXT NOT NULL, source_task_id TEXT,
 revision INTEGER NOT NULL DEFAULT 1, run_count INTEGER NOT NULL DEFAULT 1, failure_count INTEGER NOT NULL DEFAULT 0,
 last_outcome TEXT NOT NULL, has_commit INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX browser_histories_owner ON browser_histories(owner,last_used_at);
ALTER TABLE browser_operations ADD COLUMN code TEXT;
ALTER TABLE browser_operations ADD COLUMN detail_json TEXT;
ALTER TABLE browser_input_grants ADD COLUMN variable TEXT;
ALTER TABLE browser_approvals ADD COLUMN variable TEXT;`,
	},
	{
		id: "browser/0006-replays",
		after: ["browser/0005-histories"],
		sql: `CREATE TABLE browser_replays (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, history_id TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT,
 tab_ref TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX browser_replays_owner ON browser_replays(owner,started_at);`,
	},
];

export * from "./settings";
export * from "./connections";
export * from "./tabs";
export * from "./tasks";
export * from "./captures";
export * from "./approvals";
export * from "./histories";
export * from "./replays";
