import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "ui-compositions/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE ui_compositions (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
 prompt TEXT NOT NULL, motif_id TEXT, definition_json TEXT, fields_json TEXT,
 state TEXT NOT NULL, generation INTEGER NOT NULL, request_id TEXT NOT NULL,
 job_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ui_compositions_scope_updated ON ui_compositions(scope, updated_at DESC);
CREATE TABLE ui_composition_responses (
 id TEXT PRIMARY KEY, composition_id TEXT NOT NULL REFERENCES ui_compositions(id),
 generation INTEGER NOT NULL, values_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX ui_composition_responses_composition ON ui_composition_responses(composition_id, created_at DESC);
CREATE TABLE ui_composition_receipts (
 id TEXT PRIMARY KEY, composition_id TEXT NOT NULL, receipt_json TEXT NOT NULL
);
`,
	},
	{
		// One-shot generation goes: a saved composition is a `ready` row whose revision advances on
		// each explicit save. Rows that never became `ready` stay but are never listed.
		id: "ui-compositions/0002-draft-works",
		after: ["ui-compositions/0001-init"],
		sql: `
ALTER TABLE ui_compositions ADD COLUMN saved_revision INTEGER NOT NULL DEFAULT 0;
UPDATE ui_compositions SET saved_revision = generation WHERE state = 'ready';
ALTER TABLE ui_compositions DROP COLUMN generation;
ALTER TABLE ui_compositions DROP COLUMN description;
ALTER TABLE ui_compositions DROP COLUMN prompt;
ALTER TABLE ui_compositions DROP COLUMN motif_id;
ALTER TABLE ui_compositions DROP COLUMN request_id;
ALTER TABLE ui_compositions DROP COLUMN job_id;
ALTER TABLE ui_compositions DROP COLUMN error_code;
ALTER TABLE ui_composition_receipts ADD COLUMN input_digest TEXT;
CREATE TABLE ui_composition_works (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE,
 composition_id TEXT REFERENCES ui_compositions(id),
 base_saved_revision INTEGER NOT NULL, draft_revision INTEGER NOT NULL,
 generation INTEGER NOT NULL, busy_run_id TEXT, cursor INTEGER NOT NULL,
 snapshot_count INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ui_composition_works_scope ON ui_composition_works(scope, updated_at DESC);
CREATE TABLE ui_composition_snapshots (
 work_id TEXT NOT NULL REFERENCES ui_composition_works(id) ON DELETE CASCADE,
 snapshot_index INTEGER NOT NULL, title TEXT NOT NULL, definition_json TEXT,
 PRIMARY KEY (work_id, snapshot_index)
);
CREATE TABLE ui_composition_revisions (
 scope TEXT PRIMARY KEY, revision INTEGER NOT NULL
);
`,
	},
];

/** A saved composition (`ready`); other states are rows of the removed one-shot generation. */
export type CompositionRow = {
	id: string;
	scope: string;
	title: string;
	definition_json: string | null;
	fields_json: string | null;
	state: string;
	saved_revision: number;
	created_at: number;
	updated_at: number;
};
export type WorkRow = {
	id: string;
	scope: string;
	session_id: string;
	composition_id: string | null;
	base_saved_revision: number;
	draft_revision: number;
	busy_run_id: string | null;
	cursor: number;
	snapshot_count: number;
	updated_at: number;
};
export type SnapshotRow = {
	work_id: string;
	snapshot_index: number;
	title: string;
	definition_json: string | null;
};
export type StoredReceipt = {
	projectId: string;
	state: string;
	responseId?: string;
	workRef?: string;
	revision?: number;
	savedRevision?: number;
	title?: string;
};

export const get = (db: Database, id: string) =>
	db
		.query("SELECT * FROM ui_compositions WHERE id=? AND state='ready'")
		.get(id) as CompositionRow | null;
export const list = (db: Database, scope: string, limit: number) =>
	db
		.query(
			"SELECT * FROM ui_compositions WHERE scope=? AND state='ready' ORDER BY updated_at DESC, id LIMIT ?",
		)
		.all(scope, limit) as CompositionRow[];
export function insertComposition(
	db: Database,
	row: Pick<
		CompositionRow,
		"id" | "scope" | "title" | "definition_json" | "fields_json" | "created_at"
	>,
) {
	db.query(
		"INSERT INTO ui_compositions(id,scope,title,definition_json,fields_json,state,saved_revision,created_at,updated_at) VALUES(?,?,?,?,?,'ready',1,?,?)",
	).run(
		row.id,
		row.scope,
		row.title,
		row.definition_json,
		row.fields_json,
		row.created_at,
		row.created_at,
	);
}
export function updateComposition(
	db: Database,
	row: Pick<
		CompositionRow,
		"id" | "title" | "definition_json" | "fields_json" | "updated_at"
	>,
) {
	db.query(
		"UPDATE ui_compositions SET title=?, definition_json=?, fields_json=?, saved_revision=saved_revision+1, updated_at=? WHERE id=?",
	).run(
		row.title,
		row.definition_json,
		row.fields_json,
		row.updated_at,
		row.id,
	);
}

export const work = (db: Database, id: string) =>
	db
		.query("SELECT * FROM ui_composition_works WHERE id=?")
		.get(id) as WorkRow | null;
export const currentWork = (db: Database, scope: string) =>
	db
		.query(
			"SELECT * FROM ui_composition_works WHERE scope=? ORDER BY updated_at DESC LIMIT 1",
		)
		.get(scope) as WorkRow | null;
export function insertWork(
	db: Database,
	row: Pick<
		WorkRow,
		"id" | "scope" | "session_id" | "composition_id" | "base_saved_revision"
	> & { updated_at: number },
) {
	db.query(
		"INSERT INTO ui_composition_works(id,scope,session_id,composition_id,base_saved_revision,draft_revision,generation,busy_run_id,cursor,snapshot_count,updated_at) VALUES(?,?,?,?,?,0,0,NULL,0,1,?)",
	).run(
		row.id,
		row.scope,
		row.session_id,
		row.composition_id,
		row.base_saved_revision,
		row.updated_at,
	);
}
/** Replace the work's mutable state; `updated_at` follows every change. */
export function updateWork(
	db: Database,
	id: string,
	patch: Partial<
		Pick<
			WorkRow,
			| "composition_id"
			| "base_saved_revision"
			| "draft_revision"
			| "busy_run_id"
			| "cursor"
			| "snapshot_count"
		>
	>,
	now: number,
) {
	const sets = Object.keys(patch).map((key) => `${key}=?`);
	db.query(
		`UPDATE ui_composition_works SET ${[...sets, "updated_at=?"].join(",")} WHERE id=?`,
	).run(...Object.values(patch), now, id);
}
export function deleteWork(db: Database, id: string) {
	db.query("DELETE FROM ui_composition_snapshots WHERE work_id=?").run(id);
	db.query("DELETE FROM ui_composition_works WHERE id=?").run(id);
}
export const snapshot = (db: Database, workId: string, index: number) =>
	db
		.query(
			"SELECT * FROM ui_composition_snapshots WHERE work_id=? AND snapshot_index=?",
		)
		.get(workId, index) as SnapshotRow | null;
export function putSnapshot(
	db: Database,
	workId: string,
	index: number,
	title: string,
	definitionJson: string | null,
) {
	db.query(
		"INSERT OR REPLACE INTO ui_composition_snapshots(work_id,snapshot_index,title,definition_json) VALUES(?,?,?,?)",
	).run(workId, index, title, definitionJson);
}
export function dropSnapshotsAfter(
	db: Database,
	workId: string,
	index: number,
) {
	db.query(
		"DELETE FROM ui_composition_snapshots WHERE work_id=? AND snapshot_index>?",
	).run(workId, index);
}

/** The scope's revision: advances on every change a screen can show (works, saves). */
export function bumpRevision(db: Database, scope: string) {
	db.query(
		"INSERT INTO ui_composition_revisions(scope,revision) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET revision=revision+1",
	).run(scope);
}
export const revision = (db: Database, scope: string) =>
	(
		db
			.query("SELECT revision FROM ui_composition_revisions WHERE scope=?")
			.get(scope) as { revision: number } | null
	)?.revision ?? 0;

export function receipt(db: Database, id: string) {
	const row = db
		.query(
			"SELECT receipt_json,input_digest FROM ui_composition_receipts WHERE id=?",
		)
		.get(id) as { receipt_json: string; input_digest: string | null } | null;
	return row
		? {
				receipt: JSON.parse(row.receipt_json) as StoredReceipt,
				digest: row.input_digest,
			}
		: null;
}
export function saveReceipt(
	db: Database,
	id: string,
	value: StoredReceipt,
	digest: string,
) {
	db.query(
		"INSERT INTO ui_composition_receipts(id,composition_id,receipt_json,input_digest) VALUES(?,?,?,?)",
	).run(id, value.projectId, JSON.stringify(value), digest);
}
