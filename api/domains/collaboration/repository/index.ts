import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { CollaborationKind, SourceRef } from "../contracts";

export const migrations: readonly Migration[] = [
	{
		id: "collaboration/0001-works",
		after: ["dialogue/0001-init"],
		sql: `CREATE TABLE collaboration_works (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '', document_json TEXT,
 source_json TEXT, busy_run_id TEXT, ended INTEGER NOT NULL DEFAULT 0,
 child_id TEXT, child_epoch INTEGER, child_digest TEXT, child_json TEXT, last_answer_message_id TEXT,
 rejected_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX collaboration_pending ON collaboration_works(ended,child_id);
CREATE TABLE collaboration_sources (
 work_id TEXT NOT NULL REFERENCES collaboration_works(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL, run_id TEXT NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(work_id,message_id)
);
CREATE TABLE collaboration_receipts (
 request_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES collaboration_works(id) ON DELETE CASCADE,
 input_digest TEXT NOT NULL, result_json TEXT NOT NULL
);`,
	},
	{
		id: "collaboration/0002-start-message",
		after: ["collaboration/0001-works"],
		sql: "ALTER TABLE collaboration_works ADD COLUMN last_start_message_id TEXT;",
	},
];
export type WorkRow = {
	id: string;
	session_id: string;
	kind: CollaborationKind;
	revision: number;
	title: string;
	document_json: string | null;
	source_json: string | null;
	busy_run_id: string | null;
	ended: number;
	child_id: string | null;
	child_epoch: number | null;
	child_digest: string | null;
	child_json: string | null;
	rejected_json: string | null;
	last_answer_message_id: string | null;
	last_start_message_id: string | null;
	created_at: number;
	updated_at: number;
};
export const work = (db: Database, id: string) =>
	db
		.query<WorkRow, [string]>("SELECT * FROM collaboration_works WHERE id=?")
		.get(id);
export const forSession = (db: Database, id: string) =>
	db
		.query<WorkRow, [string]>(
			"SELECT * FROM collaboration_works WHERE session_id=?",
		)
		.get(id);
export const pending = (db: Database) =>
	db
		.query<WorkRow, []>(
			"SELECT * FROM collaboration_works WHERE ended=0 AND child_id IS NOT NULL AND (child_digest IS NULL OR json_extract(child_json,'$.status') IN ('running','waiting_user'))",
		)
		.all();
export const sourceRef = (row: WorkRow): SourceRef | null =>
	row.source_json ? JSON.parse(row.source_json) : null;
export const sources = (db: Database, workId: string) =>
	db
		.query<{ message_id: string; run_id: string; digest: string }, [string]>(
			"SELECT message_id,run_id,digest FROM collaboration_sources WHERE work_id=? ORDER BY rowid",
		)
		.all(workId);
