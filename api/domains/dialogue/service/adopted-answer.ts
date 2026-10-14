import type { Database } from "bun:sqlite";

/**
 * True when the message is the adopted answer of a completed run. The answer message and the run's
 * `completed` state are written in the same transaction, so a reader never sees one without the other.
 */
export function isAdoptedAnswerInTransaction(
	db: Database,
	messageId: string,
): boolean {
	return (
		db
			.query(
				"SELECT 1 FROM dialogue_runs WHERE answer_message_id = ? AND status = 'completed' LIMIT 1",
			)
			.get(messageId) != null
	);
}
