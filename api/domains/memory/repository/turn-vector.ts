import type { Database } from "bun:sqlite";

/** The newest vectors one recall compares against (a bound on the scan, not a recency rule). */
const SCAN_LIMIT = 10_000;

export interface TurnVectorRow {
	messageId: string;
	conversationId: string;
	ordinal: number;
	space: string;
	vector: Uint8Array;
	digest: string;
	createdAt: string;
}
/** One message's vector; a later one for the same message replaces it. */
export function putTurnVector(db: Database, row: TurnVectorRow) {
	db.query(
		"INSERT OR REPLACE INTO memory_turn_vector (message_id, conversation_id, ordinal, space, vector, digest, created_at) VALUES (?,?,?,?,?,?,?)",
	).run(
		row.messageId,
		row.conversationId,
		row.ordinal,
		row.space,
		row.vector,
		row.digest,
		row.createdAt,
	);
}
/** The vectors of one conversation in one space before an ordinal, newest first. */
export function turnVectorsBefore(
	db: Database,
	conversationId: string,
	space: string,
	beforeOrdinal: number,
): Array<Pick<TurnVectorRow, "messageId" | "ordinal" | "vector" | "digest">> {
	return db
		.query(
			"SELECT message_id AS messageId, ordinal, vector, digest FROM memory_turn_vector WHERE conversation_id = ? AND space = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?",
		)
		.all(conversationId, space, beforeOrdinal, SCAN_LIMIT) as Array<
		Pick<TurnVectorRow, "messageId" | "ordinal" | "vector" | "digest">
	>;
}
/** Drops the vectors of these messages (a retracted message must leave nothing derived from it). */
export function deleteTurnVectors(db: Database, messageIds: readonly string[]) {
	const remove = db.query(
		"DELETE FROM memory_turn_vector WHERE message_id = ?",
	);
	for (const id of messageIds) remove.run(id);
}
