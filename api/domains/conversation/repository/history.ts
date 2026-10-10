import type { Database } from "bun:sqlite";
import { latestEvent, retractionReady } from ".";
export type HistoryRow = {
	id: string;
	role: "user" | "assistant";
	created_at: string;
	size: number;
};
const live = (db: Database) =>
	retractionReady(db) ? " AND retracted_at IS NULL" : "";
export function historyBound(
	db: Database,
	conversationId: string,
	exclude?: string,
): string | null {
	return (
		(
			db
				.query(
					`SELECT id FROM messages WHERE conversation_id=?${exclude ? " AND rowid < (SELECT rowid FROM messages WHERE id=? AND conversation_id=?)" : ""}${live(db)} ORDER BY rowid DESC LIMIT 1`,
				)
				.get(
					...(exclude
						? [conversationId, exclude, conversationId]
						: [conversationId]),
				) as { id: string } | null
		)?.id ?? null
	);
}
/** A finite metadata batch is selected before any text is inspected. Rowids never leave SQL. */
export function historyBatch(
	db: Database,
	conversationId: string,
	bound: string | null,
	last: string | null,
	includeLast: boolean,
	limit: number,
): HistoryRow[] {
	if (!bound) return [];
	return db
		.query(
			`SELECT id,role,created_at,length(text) AS size FROM messages WHERE conversation_id=? AND rowid <= (SELECT rowid FROM messages WHERE id=? AND conversation_id=?)${last ? ` AND rowid ${includeLast ? "<=" : "<"} (SELECT rowid FROM messages WHERE id=? AND conversation_id=?)` : ""}${live(db)} ORDER BY rowid DESC LIMIT ?`,
		)
		.all(
			...(last
				? [conversationId, bound, conversationId, last, conversationId, limit]
				: [conversationId, bound, conversationId, limit]),
		) as HistoryRow[];
}
export function historyChunk(
	db: Database,
	conversationId: string,
	messageId: string,
	start: number,
	count: number,
): string {
	return (
		(
			db
				.query(
					`SELECT substr(text,?,?) AS text FROM messages WHERE id=? AND conversation_id=?${live(db)}`,
				)
				.get(start + 1, count, messageId, conversationId) as {
				text: string;
			} | null
		)?.text ?? ""
	);
}
export function historyIdentity(db: Database, id: string) {
	const event = latestEvent(db, id);
	if (
		!event ||
		!event.digest ||
		["retracted", "superseded"].includes(event.revision)
	)
		throw new Error("history_source_unavailable");
	return { revision: event.revision, digest: event.digest };
}
export function historyNeighbors(
	db: Database,
	conversationId: string,
	bound: string | null,
	id: string,
	before: number,
	after: number,
): HistoryRow[] {
	if (!bound) return [];
	const select = `SELECT id,role,created_at,length(text) AS size FROM messages WHERE conversation_id=? AND rowid <= (SELECT rowid FROM messages WHERE id=? AND conversation_id=?)${live(db)}`;
	const previous = db
		.query(
			`${select} AND rowid < (SELECT rowid FROM messages WHERE id=? AND conversation_id=?) ORDER BY rowid DESC LIMIT ?`,
		)
		.all(
			conversationId,
			bound,
			conversationId,
			id,
			conversationId,
			before,
		) as HistoryRow[];
	const next = db
		.query(
			`${select} AND rowid >= (SELECT rowid FROM messages WHERE id=? AND conversation_id=?) ORDER BY rowid LIMIT ?`,
		)
		.all(
			conversationId,
			bound,
			conversationId,
			id,
			conversationId,
			after + 1,
		) as HistoryRow[];
	return [...previous.reverse(), ...next];
}
