import type { Database } from "bun:sqlite";

/** Session-local privacy exclusion is distinct from loss of authority to use a source. */
export function isSourceRevoked(db: Database, messageId: string): boolean {
	const row = db
		.query<{ reason: string }, [string]>(
			"SELECT reason FROM memory_message_block WHERE message_id=?",
		)
		.get(messageId);
	return !!row && row.reason !== "specialist_dialogue";
}
