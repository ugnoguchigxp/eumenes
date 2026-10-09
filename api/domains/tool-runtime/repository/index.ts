import type { Database } from "bun:sqlite";
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
