import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

/**
 * `steward/0010-event-failure`: the memory reflection reads the conversation's new events again (the sleep layer that
 * took them over is gone), so the failed tries over one event are counted again, as `steward/0003` did: the third
 * failure gives the event up.
 */
export const eventFailureMigration: Migration = {
	id: "steward/0010-event-failure",
	after: ["steward/0009-sleep-pressure"],
	sql: `
CREATE TABLE steward_event_failure (
 conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (conversation_id, seq)
);
`,
};

// ---- failed memory reflections, per event ----

export function eventFailures(
	db: Database,
	conversationId: string,
	seqs: readonly number[],
): Map<number, number> {
	const found = new Map<number, number>();
	const read = db.query(
		"SELECT failures FROM steward_event_failure WHERE conversation_id = ? AND seq = ?",
	);
	for (const seq of seqs) {
		const row = read.get(conversationId, seq) as { failures: number } | null;
		if (row) found.set(seq, row.failures);
	}
	return found;
}
export function bumpEventFailure(
	db: Database,
	conversationId: string,
	seq: number,
): number {
	db.query(
		`INSERT INTO steward_event_failure (conversation_id, seq, failures) VALUES (?,?,1)
		 ON CONFLICT(conversation_id, seq) DO UPDATE SET failures = failures + 1`,
	).run(conversationId, seq);
	return eventFailures(db, conversationId, [seq]).get(seq) ?? 0;
}
export function deleteEventFailures(
	db: Database,
	conversationId: string,
	seqs: readonly number[],
) {
	const remove = db.query(
		"DELETE FROM steward_event_failure WHERE conversation_id = ? AND seq = ?",
	);
	for (const seq of seqs) remove.run(conversationId, seq);
}
