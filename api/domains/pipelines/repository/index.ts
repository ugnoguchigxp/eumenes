import type { Database } from "bun:sqlite";
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

export type WorkRow = {
	id: string;
	session_id: string;
	/** The published pipeline's toolchain id this work started from or was published as. */
	target_id: string | null;
	revision: number;
	title: string;
	text: string;
	previous_text: string;
	/** Digest of the text as last published (or as opened from a published pipeline). */
	published_digest: string | null;
	busy_run_id: string | null;
	rejected_json: string | null;
	updated_at: number;
};

export const work = (db: Database, id: string) =>
	db.query("SELECT * FROM pipeline_works WHERE id=?").get(id) as WorkRow | null;
export const workOfSession = (db: Database, sessionId: string) =>
	db
		.query("SELECT * FROM pipeline_works WHERE session_id=?")
		.get(sessionId) as WorkRow | null;
export const latestWork = (db: Database) =>
	db
		.query("SELECT * FROM pipeline_works ORDER BY updated_at DESC LIMIT 1")
		.get() as WorkRow | null;

export function insertWork(db: Database, row: WorkRow) {
	db.query(
		"INSERT INTO pipeline_works (id,session_id,target_id,revision,title,text,previous_text,published_digest,busy_run_id,rejected_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		row.id,
		row.session_id,
		row.target_id,
		row.revision,
		row.title,
		row.text,
		row.previous_text,
		row.published_digest,
		row.busy_run_id,
		row.rejected_json,
		row.updated_at,
	);
}
export function updateWork(
	db: Database,
	id: string,
	change: Partial<Omit<WorkRow, "id" | "session_id">>,
) {
	const keys = Object.keys(change) as Array<keyof typeof change>;
	db.query(
		`UPDATE pipeline_works SET ${keys.map((k) => `${k}=?`).join(",")},updated_at=? WHERE id=?`,
	).run(...keys.map((k) => change[k] ?? null), Date.now(), id);
}
export function deleteWork(db: Database, id: string) {
	db.query("DELETE FROM pipeline_work_versions WHERE work_id=?").run(id);
	db.query("DELETE FROM pipeline_receipts WHERE work_id=?").run(id);
	db.query("DELETE FROM pipeline_works WHERE id=?").run(id);
}
export function putVersion(
	db: Database,
	v: {
		workId: string;
		revision: number;
		title: string;
		text: string;
		origin: string;
	},
) {
	db.query(
		"INSERT INTO pipeline_work_versions (work_id,revision,title,text,origin,created_at) VALUES (?,?,?,?,?,?)",
	).run(v.workId, v.revision, v.title, v.text, v.origin, Date.now());
}

export const receipt = (db: Database, id: string) =>
	db
		.query(
			"SELECT input_digest, receipt_json FROM pipeline_receipts WHERE id=?",
		)
		.get(id) as { input_digest: string; receipt_json: string } | null;
export function saveReceipt(
	db: Database,
	id: string,
	workId: string,
	digest: string,
	value: unknown,
) {
	db.query(
		"INSERT INTO pipeline_receipts (id,work_id,input_digest,receipt_json) VALUES (?,?,?,?)",
	).run(id, workId, digest, JSON.stringify(value));
}

/** The studio source's revision: advances on every change a screen should see. */
export const studioRevision = (db: Database) =>
	(
		db
			.query("SELECT revision FROM pipeline_studio_revision WHERE id=1")
			.get() as {
			revision: number;
		}
	).revision;
export const bumpStudioRevision = (db: Database) =>
	db
		.query("UPDATE pipeline_studio_revision SET revision=revision+1 WHERE id=1")
		.run();
