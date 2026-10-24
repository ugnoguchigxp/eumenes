import type { Database } from "bun:sqlite";

/**
 * The exchange ledger and the conversation summary of the earlier design, kept under new names by
 * `memory/0010-retire-exchange-ledger` until the one-time backfill has turned them into continuity events
 * (see `service/backfill.ts`), and then dropped. Nothing else reads these tables.
 */
export interface RetiredExchange {
	inputMessageId: string;
	answerMessageId: string | null;
	conversationId: string;
	inputOrdinal: number;
	state: "pending" | "done";
	disposition: "keep" | "summarize" | "drop" | null;
}
export interface RetiredSummary {
	text: string;
	updatedAt: string;
	/** Input message ids of the exchanges the text stands on. */
	sources: string[];
}

const TABLES = [
	"memory_retired_exchange",
	"memory_retired_summary",
	"memory_retired_summary_source",
] as const;

/** The retired tables still exist (the backfill has not finished yet). */
export function hasRetiredLedger(db: Database): boolean {
	return (
		(
			db
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'memory_retired_exchange'",
				)
				.get() as { n: number }
		).n > 0
	);
}
export function retiredConversationIds(db: Database): string[] {
	return (
		db
			.query(
				`SELECT conversation_id AS id FROM memory_retired_exchange
				 UNION SELECT conversation_id FROM memory_retired_summary ORDER BY id`,
			)
			.all() as Array<{ id: string }>
	).map((row) => row.id);
}
/** Every exchange of a conversation, oldest first. */
export function retiredExchanges(
	db: Database,
	conversationId: string,
): RetiredExchange[] {
	return db
		.query(
			`SELECT input_message_id AS inputMessageId, answer_message_id AS answerMessageId,
			 conversation_id AS conversationId, input_ordinal AS inputOrdinal, state, disposition
			 FROM memory_retired_exchange WHERE conversation_id = ? ORDER BY input_ordinal`,
		)
		.all(conversationId) as RetiredExchange[];
}
export function retiredSummary(
	db: Database,
	conversationId: string,
): RetiredSummary | null {
	const row = db
		.query(
			"SELECT text, revision, updated_at AS updatedAt FROM memory_retired_summary WHERE conversation_id = ?",
		)
		.get(conversationId) as {
		text: string;
		revision: number;
		updatedAt: string;
	} | null;
	if (!row) return null;
	const sources = (
		db
			.query(
				"SELECT input_message_id AS id FROM memory_retired_summary_source WHERE conversation_id = ? AND revision = ? ORDER BY input_message_id",
			)
			.all(conversationId, row.revision) as Array<{ id: string }>
	).map((source) => source.id);
	return { text: row.text, updatedAt: row.updatedAt, sources };
}
/** Removes a handled conversation's retired rows. */
export function deleteRetiredConversation(
	db: Database,
	conversationId: string,
) {
	for (const table of TABLES)
		db.query(`DELETE FROM ${table} WHERE conversation_id = ?`).run(
			conversationId,
		);
}
/** Drops the retired tables (the backfill has run for every conversation). */
export function dropRetiredLedger(db: Database) {
	for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}
