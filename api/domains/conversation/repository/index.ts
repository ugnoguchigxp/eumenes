import type { Database } from "bun:sqlite";
import {
	speechDeliverySchema,
	type SpeechDelivery,
	type AvatarMotion,
} from "../../delivery";
import type { Message } from "../contracts";

export const migration = `
CREATE TABLE conversations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at, id);
`;
export const avatarMotionMigration = `
CREATE TABLE answer_avatar_motions (run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), motion TEXT NOT NULL);
CREATE INDEX answer_avatar_motions_conversation ON answer_avatar_motions(conversation_id);
`;
export const answerDeliveryMigration = `
CREATE TABLE answer_deliveries (run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), delivery TEXT NOT NULL);
CREATE INDEX answer_deliveries_conversation ON answer_deliveries(conversation_id);
`;
export function recordAnswerDelivery(
	db: Database,
	runId: string,
	conversationId: string,
	delivery: SpeechDelivery,
) {
	const parsed = speechDeliverySchema.parse(delivery);
	const old = db
		.query("SELECT delivery FROM answer_deliveries WHERE run_id=?")
		.get(runId) as { delivery: string } | null;
	if (old) {
		const previous = speechDeliverySchema.parse(JSON.parse(old.delivery));
		// An accepted answer-wide decision is stable. A fallback may be retried on replay.
		if (
			previous.version === 2 &&
			(previous.source === "laya" || parsed.source !== "laya")
		)
			return false;
	}
	db.query(
		"INSERT INTO answer_deliveries (run_id, conversation_id, delivery) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET delivery=excluded.delivery",
	).run(runId, conversationId, JSON.stringify(parsed));
	db.query("UPDATE conversations SET revision=revision+1 WHERE id=?").run(
		conversationId,
	);
	return true;
}
export function recordAnswerMotion(
	db: Database,
	runId: string,
	conversationId: string,
	motion: AvatarMotion,
): boolean {
	const result = db
		.query(
			"INSERT OR IGNORE INTO answer_avatar_motions (run_id, conversation_id, motion) VALUES (?, ?, ?)",
		)
		.run(runId, conversationId, motion);
	if (!result.changes) return false;
	db.query("UPDATE conversations SET revision = revision + 1 WHERE id = ?").run(
		conversationId,
	);
	return true;
}
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
			"SELECT m.id, m.conversation_id, m.role, m.text, m.created_at, m.run_id, a.motion, d.delivery FROM messages m LEFT JOIN answer_avatar_motions a ON a.run_id = m.run_id AND a.conversation_id = m.conversation_id AND m.role = 'assistant' LEFT JOIN answer_deliveries d ON d.run_id = m.run_id AND d.conversation_id = m.conversation_id AND m.role = 'assistant' WHERE m.conversation_id = ? ORDER BY m.rowid",
		)
		.all(id) as Array<{
		id: string;
		conversation_id: string;
		role: "user" | "assistant";
		text: string;
		created_at: string;
		run_id: string | null;
		motion: AvatarMotion | null;
		delivery: string | null;
	}>;
	return rows.map((row) => ({
		id: row.id,
		conversationId: row.conversation_id,
		role: row.role,
		text: row.text,
		createdAt: row.created_at,
		runId: row.run_id,
		...(row.motion ? { avatarMotion: row.motion } : {}),
		...(row.delivery
			? { delivery: speechDeliverySchema.parse(JSON.parse(row.delivery)) }
			: {}),
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
/** One message with its acceptance-order ordinal (rowid), regardless of conversation. */
export function getMessage(
	db: Database,
	id: string,
): { message: Message; ordinal: number } | null {
	const row = db
		.query(
			"SELECT m.rowid AS ordinal, m.id, m.conversation_id, m.role, m.text, m.created_at, m.run_id FROM messages m WHERE m.id = ?",
		)
		.get(id) as {
		ordinal: number;
		id: string;
		conversation_id: string;
		role: "user" | "assistant";
		text: string;
		created_at: string;
		run_id: string | null;
	} | null;
	if (!row) return null;
	return {
		ordinal: row.ordinal,
		message: {
			id: row.id,
			conversationId: row.conversation_id,
			role: row.role,
			text: row.text,
			createdAt: row.created_at,
			runId: row.run_id,
		},
	};
}
