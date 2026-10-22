import type { Database } from "bun:sqlite";

/** True when the conversation has a queued or running run (read-only; the conversation index serves it). */
export function conversationHasActiveRun(
	db: Database,
	conversationId: string,
): boolean {
	return (
		db
			.query(
				"SELECT 1 FROM dialogue_runs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1",
			)
			.get(conversationId) !== null
	);
}
