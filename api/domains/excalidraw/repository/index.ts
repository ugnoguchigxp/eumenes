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
