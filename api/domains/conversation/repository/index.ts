import type { Database } from "bun:sqlite";
import type { Message } from "../contracts";

export const migration = `
CREATE TABLE conversations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at, id);
`;
export function ensureConversation(db: Database, id: string, now: string) {
	db.query(
		"INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)",
	).run(id, now);
}
export function appendMessage(db: Database, message: Message): number {
	db.query(
		"INSERT INTO messages (id, conversation_id, role, text, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		message.id,
		message.conversationId,
		message.role,
		message.text,
		message.createdAt,
		message.runId,
	);
	db.query("UPDATE conversations SET revision = revision + 1 WHERE id = ?").run(
		message.conversationId,
	);
	return (
		db
			.query("SELECT revision FROM conversations WHERE id = ?")
			.get(message.conversationId) as { revision: number }
	).revision;
}
export function listMessages(db: Database, id: string): Message[] {
	const rows = db
		.query(
			"SELECT id, conversation_id, role, text, created_at, run_id FROM messages WHERE conversation_id = ? ORDER BY rowid",
		)
		.all(id) as Array<{
		id: string;
		conversation_id: string;
		role: "user" | "assistant";
		text: string;
		created_at: string;
		run_id: string | null;
	}>;
	return rows.map((row) => ({
		id: row.id,
		conversationId: row.conversation_id,
		role: row.role,
		text: row.text,
		createdAt: row.created_at,
		runId: row.run_id,
	}));
}
export function revision(db: Database, id: string): number {
	return (
		(
			db.query("SELECT revision FROM conversations WHERE id = ?").get(id) as {
				revision: number;
			} | null
		)?.revision ?? 0
	);
}
