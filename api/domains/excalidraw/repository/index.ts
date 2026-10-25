import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { DrawingSession, Reference } from "../contracts";
export const migrations: readonly Migration[] = [
	{
		id: "excalidraw/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE excalidraw_references(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,document_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,title TEXT NOT NULL);
CREATE TABLE excalidraw_sessions(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_json TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE excalidraw_operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,record_json TEXT NOT NULL,request_json TEXT NOT NULL,bindings_json TEXT NOT NULL,deadline INTEGER NOT NULL,job_id TEXT);
`,
	},
	{
		id: "excalidraw/0002-execution-calls",
		after: ["excalidraw/0001-init"],
		sql: `
CREATE TABLE excalidraw_operations_next(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,conversation_id TEXT NOT NULL,record_json TEXT NOT NULL,request_json TEXT NOT NULL,bindings_json TEXT NOT NULL,deadline INTEGER NOT NULL,job_id TEXT);
INSERT INTO excalidraw_operations_next SELECT * FROM excalidraw_operations;
DROP TABLE excalidraw_operations;
ALTER TABLE excalidraw_operations_next RENAME TO excalidraw_operations;
CREATE UNIQUE INDEX excalidraw_source_once ON excalidraw_operations(run_id) WHERE json_extract(request_json,'$.execution') IS NULL;`,
	},
];
export function getSession(db: Database, id: string): DrawingSession | null {
	const r = db
		.query("SELECT record_json FROM excalidraw_sessions WHERE id=?")
		.get(id) as { record_json: string } | null;
	return r ? JSON.parse(r.record_json) : null;
}
export function updateSession(
	db: Database,
	id: string,
	change: Partial<DrawingSession>,
) {
	const s = getSession(db, id);
	if (!s) throw new Error("excalidraw_session_not_found");
	const value = { ...s, ...change };
	db.query("UPDATE excalidraw_sessions SET record_json=? WHERE id=?").run(
		JSON.stringify(value),
		id,
	);
	return value;
}
export function references(db: Database, conversationId: string): Reference[] {
	return db
		.query(
			"SELECT id,conversation_id AS conversationId,document_id AS documentId,revision,title FROM excalidraw_references WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100",
		)
		.all(conversationId) as Reference[];
}
export function saveReference(
	db: Database,
	conversationId: string,
	drawing: { id: string; revision: number; title: string },
) {
	db.query(
		"INSERT INTO excalidraw_references VALUES(?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision,title=excluded.title WHERE excluded.revision>=excalidraw_references.revision",
	).run(
		crypto.randomUUID(),
		conversationId,
		drawing.id,
		drawing.revision,
		drawing.title,
	);
	return (
		db
			.query("SELECT id FROM excalidraw_references WHERE document_id=?")
			.get(drawing.id) as { id: string }
	).id;
}
export function reference(db: Database, id: string): Reference | null {
	return db
		.query(
			"SELECT id,conversation_id AS conversationId,document_id AS documentId,revision,title FROM excalidraw_references WHERE id=?",
		)
		.get(id) as Reference | null;
}

/**
 * A saved drawing as a resource lists it. References carry no creation time, so `at` is the earliest
 * `lastOperation` of the sessions opened on the drawing (null when none is left).
 */
export type DrawingEntry = Reference & { at: number | null };
const ENTRY =
	"SELECT r.id,r.conversation_id AS conversationId,r.document_id AS documentId,r.revision,r.title,(SELECT MIN(json_extract(s.record_json,'$.lastOperation')) FROM excalidraw_sessions s WHERE json_extract(s.record_json,'$.referenceId')=r.id) AS at FROM excalidraw_references r WHERE r.conversation_id=?";
export const drawingEntry = (
	db: Database,
	conversationId: string,
	id: string,
) =>
	db
		.query(`${ENTRY} AND r.id=?`)
		.get(conversationId, id) as DrawingEntry | null;
/** The conversation's drawings, newest saved first. */
export const drawingEntries = (
	db: Database,
	conversationId: string,
	limit: number,
) =>
	db
		.query(`${ENTRY} ORDER BY r.rowid DESC LIMIT ?`)
		.all(conversationId, limit) as DrawingEntry[];
