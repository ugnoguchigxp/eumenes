import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

/**
 * The messages an immediate forget hides from the history until its closure delete removes them (the memory
 * architecture redesign, section 9.2). The memory's block ledger takes them at the closure; until then this is what
 * `read_history` leaves out.
 */
export const forgetHiddenMigration: Migration = {
	id: "dialogue/0046-forget-hidden",
	after: ["dialogue/0045-consumed-confirmation-run"],
	sql: `CREATE TABLE dialogue_forget_hidden (
 message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, hidden_at TEXT NOT NULL
);
CREATE INDEX dialogue_forget_hidden_conversation ON dialogue_forget_hidden(conversation_id);`,
};

export function hideMessages(
	db: Database,
	conversationId: string,
	messageIds: readonly string[],
	at: string,
) {
	for (const messageId of messageIds)
		db.query(
			"INSERT OR IGNORE INTO dialogue_forget_hidden(message_id, conversation_id, hidden_at) VALUES (?,?,?)",
		).run(messageId, conversationId, at);
}

export function hiddenMessages(db: Database, conversationId: string): string[] {
	return db
		.query<{ message_id: string }, [string]>(
			"SELECT message_id FROM dialogue_forget_hidden WHERE conversation_id = ?",
		)
		.all(conversationId)
		.map((row) => row.message_id);
}

/** The closure delete removed them (the memory's ledger blocks them from then on). */
export function releaseHiddenMessages(
	db: Database,
	messageIds: readonly string[],
) {
	for (const messageId of messageIds)
		db.query("DELETE FROM dialogue_forget_hidden WHERE message_id = ?").run(
			messageId,
		);
}
