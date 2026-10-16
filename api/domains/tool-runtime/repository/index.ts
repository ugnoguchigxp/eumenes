import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Invocation } from "../contracts";
export const migration = `
CREATE TABLE tool_invocations(id TEXT PRIMARY KEY,owner_task_id TEXT NOT NULL,root_run_id TEXT NOT NULL,tool_revision_id TEXT NOT NULL,step_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,args_json TEXT,args_digest TEXT NOT NULL,operation_id TEXT NOT NULL,job_id TEXT NOT NULL,state TEXT NOT NULL,result_ref TEXT,result_digest TEXT,error_code TEXT,deadline INTEGER NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,UNIQUE(step_id));
CREATE TABLE tool_sources(id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL,owner_task_id TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,basis TEXT NOT NULL,fetched_at TEXT NOT NULL,body_digest TEXT NOT NULL,truncated INTEGER NOT NULL);
CREATE INDEX tool_invocations_waiting ON tool_invocations(state);
`;
export const get = (db: Database, id: string) =>
	db
		.query("SELECT * FROM tool_invocations WHERE id=?")
		.get(id) as Invocation | null;
/** Appended migration: marks observations imported from the candidate cache (never a real lookup). */
export const routeGrantMigration = `
ALTER TABLE tool_invocations ADD COLUMN origin TEXT NOT NULL DEFAULT 'tool';
`;
/** Appended migration: invocations replaced by a new acquisition plan stay budgeted but are no longer observed. */
export const supersedeMigration = `
ALTER TABLE tool_invocations ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;
`;
/** Appended: immediate local actions. Does not alter tool_invocations. */
export const actionMigration = `
CREATE TABLE tool_action_invocations(
  id TEXT PRIMARY KEY,
  root_run_id TEXT NOT NULL,
  owner_task_id TEXT NOT NULL,
  cancel_epoch INTEGER NOT NULL,
  step_id TEXT NOT NULL UNIQUE,
  tool_revision_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  args_digest TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state='committed'),
  created_at INTEGER NOT NULL
);
`;
const columnCache = new WeakMap<Database, boolean>();
export function hasSupersededColumn(db: Database) {
	let v = columnCache.get(db);
	if (v === undefined) {
		v = (
			db.query("PRAGMA table_info(tool_invocations)").all() as {
				name: string;
			}[]
		).some((c) => c.name === "superseded");
		columnCache.set(db, v);
	}
	return v;
}

export const readMetadataMigration = `
ALTER TABLE tool_invocations ADD COLUMN cancel_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tool_invocations ADD COLUMN operation_fingerprint TEXT;
CREATE TABLE tool_views(view_id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL REFERENCES tool_invocations(id) ON DELETE CASCADE,metadata_json TEXT NOT NULL);
CREATE TABLE tool_read_proofs(invocation_id TEXT NOT NULL REFERENCES tool_invocations(id) ON DELETE CASCADE,proof_json TEXT NOT NULL);
`;
const readColumns = new WeakMap<Database, boolean>();
export function hasReadMetadata(db: Database) {
	let v = readColumns.get(db);
	if (v === undefined) {
		v = !!db.query("SELECT 1 FROM sqlite_master WHERE name='tool_views'").get();
		readColumns.set(db, v);
	}
	return v;
}
/** Appended: which registered adapter and operation executed an agent action (spec §5.3). */
export const actionAdapterMigration = `
ALTER TABLE tool_action_invocations ADD COLUMN adapter_ref TEXT NOT NULL DEFAULT 'adapter:timers@1';
ALTER TABLE tool_action_invocations ADD COLUMN operation_name TEXT;
`;
/**
 * Appended: the acceptance ledger of UI actions (spec §6.4). One row per eventId, written in
 * the same writer transaction as the domain execution. Bodies (canonical_input_json,
 * result_json) are deleted after settlement; the row stays as a tombstone for a while so a
 * late resend of the same eventId never turns into a new execution.
 */
const actionRequestsMigration = `
CREATE TABLE tool_action_requests(
  event_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK(owner_kind='ui'),
  artifact_revision_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  target_ref TEXT,
  action_id TEXT NOT NULL,
  adapter_ref TEXT NOT NULL,
  operation_name TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  canonical_input_json TEXT,
  input_digest TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  event_created_at TEXT NOT NULL,
  event_expires_at TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','indeterminate')),
  error_code TEXT,
  receipt_owner TEXT,
  receipt_operation_id TEXT,
  receipt_digest TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  body_deleted_at INTEGER
);
CREATE INDEX tool_action_requests_unsettled ON tool_action_requests(scope,created_at) WHERE status IN ('pending','indeterminate');
CREATE INDEX tool_action_requests_settled ON tool_action_requests(settled_at) WHERE settled_at IS NOT NULL;
CREATE TABLE tool_action_request_conflicts(
  event_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(event_id,input_digest)
);
`;
/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "tool-runtime/0001-init", sql: migration },
	{ id: "tool-runtime/0002-route-grant", sql: routeGrantMigration },
	{ id: "tool-runtime/0003-supersede", sql: supersedeMigration },
	{ id: "tool-runtime/0004-action", sql: actionMigration },
	{
		id: "tool-runtime/0005-read-metadata",
		sql: readMetadataMigration,
		after: ["tool-runtime/0004-action"],
	},
	{
		id: "tool-runtime/0006-action-adapter",
		sql: actionAdapterMigration,
		after: ["tool-runtime/0005-read-metadata"],
	},
	{
		id: "tool-runtime/0007-action-requests",
		sql: actionRequestsMigration,
		after: ["tool-runtime/0006-action-adapter"],
	},
];
