import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { WorkKind, SourceRef, ReviewOutcome } from "../contracts";

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
	{
		id: "collaboration/0003-review",
		after: ["collaboration/0002-start-message"],
		sql: "ALTER TABLE collaboration_works ADD COLUMN review_json TEXT;",
	},
	{
		id: "collaboration/0004-task-continuation",
		after: ["collaboration/0003-review"],
		sql: `ALTER TABLE collaboration_works ADD COLUMN child_borrowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collaboration_works ADD COLUMN offer_json TEXT;`,
	},
];
export type ReviewRow = {
	id: string;
	revision: number;
	epoch: number;
	runId: string;
	jobId: string;
	conditions?: string;
	outcome?: ReviewOutcome;
};
export type WorkRow = {
	id: string;
	session_id: string;
	kind: WorkKind;
	revision: number;
	title: string;
	document_json: string | null;
	source_json: string | null;
	busy_run_id: string | null;
	ended: number;
	child_id: string | null;
	child_borrowed: number;
	offer_json: string | null;
	child_epoch: number | null;
	child_digest: string | null;
	child_json: string | null;
	rejected_json: string | null;
	review_json: string | null;
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
export const reviewOf = (row: WorkRow): ReviewRow | null =>
	row.review_json ? JSON.parse(row.review_json) : null;
export function writeReview(
	db: Database,
	workId: string,
	review: ReviewRow | null,
) {
	db.query("UPDATE collaboration_works SET review_json=? WHERE id=?").run(
		review ? JSON.stringify(review) : null,
		workId,
	);
}
export const sources = (db: Database, workId: string) =>
	db
		.query<{ message_id: string; run_id: string; digest: string }, [string]>(
			"SELECT message_id,run_id,digest FROM collaboration_sources WHERE work_id=? ORDER BY rowid",
		)
		.all(workId);
