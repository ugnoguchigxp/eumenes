import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
export const migrations: readonly Migration[] = [
	{
		id: "markdown/0001-workspaces",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE markdown_workspaces (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, content_json TEXT NOT NULL, revision INTEGER NOT NULL,
 source_id TEXT, remote_revision TEXT, archived_revision INTEGER NOT NULL DEFAULT 0,
 save_job_id TEXT, save_state TEXT NOT NULL DEFAULT 'unsaved', save_error TEXT, updated_at INTEGER NOT NULL,
 saved_content_json TEXT, saved_title TEXT
);
CREATE TABLE markdown_sessions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES markdown_workspaces(id), session_id TEXT NOT NULL UNIQUE, busy_run_id TEXT, rejected_json TEXT);
CREATE TABLE markdown_receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt_json TEXT NOT NULL);
CREATE TABLE markdown_saves (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, title TEXT NOT NULL, content_json TEXT NOT NULL, markdown TEXT NOT NULL, revision INTEGER NOT NULL, source_id TEXT, remote_revision TEXT, binding TEXT NOT NULL);
`,
	},
	{
		// Applied migrations stay byte-for-byte (0001 and 0002 ran on the live database); later changes are appended.
		id: "markdown/0002-inputs",
		after: ["markdown/0001-workspaces"],
		sql: `
CREATE TABLE markdown_inputs(id TEXT PRIMARY KEY, content_json TEXT NOT NULL, markdown TEXT, expires_at INTEGER NOT NULL);
`,
	},
	{
		id: "markdown/0003-created-unique-saves",
		after: ["markdown/0002-inputs"],
		sql: `
ALTER TABLE markdown_workspaces ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX markdown_saves_document ON markdown_saves(document_id);
`,
	},
];
export type Workspace = {
	id: string;
	title: string;
	content_json: string;
	revision: number;
	source_id: string | null;
	remote_revision: string | null;
	archived_revision: number;
	save_job_id: string | null;
	save_state: string;
	save_error: string | null;
	updated_at: number;
	created_at: number;
	saved_content_json: string | null;
	saved_title: string | null;
};
export type SessionRow = {
	id: string;
	document_id: string;
	session_id: string;
	busy_run_id: string | null;
	rejected_json: string | null;
};
export const row = (db: Database, id: string) =>
	db
		.query("SELECT * FROM markdown_workspaces WHERE id=?")
		.get(id) as Workspace | null;
export const session = (db: Database, id: string) =>
	db
		.query("SELECT * FROM markdown_sessions WHERE id=?")
		.get(id) as SessionRow | null;
export const list = (db: Database) =>
	db
		.query(
			"SELECT id,title,revision,source_id,save_state,updated_at FROM markdown_workspaces ORDER BY updated_at DESC LIMIT 100",
		)
		.all() as Pick<
		Workspace,
		"id" | "title" | "revision" | "source_id" | "save_state" | "updated_at"
	>[];

export type PendingSave = {
	id: string;
	document_id: string;
	title: string;
	content_json: string;
	markdown: string;
	revision: number;
	source_id: string | null;
	remote_revision: string | null;
	binding: string;
};
