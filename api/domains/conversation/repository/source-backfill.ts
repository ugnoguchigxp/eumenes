import type { Database } from "bun:sqlite";
import {
	insertEvent,
	outboxReady,
	retractionReady,
	textRevision,
	type OutboxOptions,
} from ".";

/** Source-owned, bounded backfill. Existing events are the durable deduplication record. */
export function backfillSourceEvents(
	db: Database,
	options: OutboxOptions,
	after = 0,
	limit = 200,
) {
	if (!db.inTransaction) throw new Error("transaction_required");
	if (!outboxReady(db)) throw new Error("conversation_outbox_missing");
	if (
		!Number.isSafeInteger(after) ||
		after < 0 ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 500
	)
		throw new RangeError("invalid_backfill_page");
	const rows = db
		.query(
			`SELECT m.rowid AS position, m.id, m.conversation_id, m.role, m.text, m.created_at
		FROM messages m WHERE m.rowid > ?${retractionReady(db) ? " AND m.retracted_at IS NULL" : ""}
		AND NOT EXISTS (SELECT 1 FROM conversation_outbox o WHERE o.source_id = m.id)
		ORDER BY m.rowid LIMIT ?`,
		)
		.all(after, limit + 1) as {
		position: number;
		id: string;
		conversation_id: string;
		role: "user" | "assistant";
		text: string;
		created_at: string;
	}[];
	const page = rows.slice(0, limit);
	for (const row of page)
		insertEvent(db, options, {
			kind: "added",
			messageId: row.id,
			conversationId: row.conversation_id,
			speaker: row.role,
			...textRevision(row.text),
			at: row.created_at,
		});
	return {
		added: page.length,
		after: page.at(-1)?.position ?? after,
		hasMore: rows.length > limit,
	};
}
