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
];

export * from "./settings";
export * from "./connections";
export * from "./tabs";
export * from "./tasks";
export * from "./captures";
export * from "./approvals";
