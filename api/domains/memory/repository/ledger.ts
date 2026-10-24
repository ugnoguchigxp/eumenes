import type { Database } from "bun:sqlite";

/**
 * The blocked messages and the forget fence: what the dialogue, the steward and the forget read and write.
 * Row shapes live in `memory/0005-steward-ledgers` (the exchange ledger and the conversation summary it created
 * were retired by `memory/0010-retire-exchange-ledger`; see `retired-ledger.ts`).
 */

export type BlockReason =
	| "scheduled_prompt"
	| "forgotten"
	| "specialist_dialogue";

// ---- blocked messages ----

export function insertBlocks(
	db: Database,
	blocks: ReadonlyArray<{
		messageId: string;
		conversationId: string;
		reason: BlockReason;
		forgetId: string | null;
	}>,
	now: string,
) {
	const insert = db.query(
		`INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES (?,?,?,?,?)
		 ON CONFLICT(message_id) DO UPDATE SET
		  reason = CASE WHEN excluded.reason = 'forgotten' THEN 'forgotten' ELSE memory_message_block.reason END,
		  forget_id = COALESCE(excluded.forget_id, memory_message_block.forget_id)`,
	);
	for (const block of blocks)
		insert.run(
			block.messageId,
			block.conversationId,
			block.reason,
			block.forgetId,
			now,
		);
}
/** Lift the specialist-dialogue block of these messages; a block of any other reason (e.g. forgotten) stays. */
export function deleteSpecialistBlocks(
	db: Database,
	messageIds: readonly string[],
) {
	const remove = db.query(
		"DELETE FROM memory_message_block WHERE message_id = ? AND reason = 'specialist_dialogue'",
	);
	for (const id of messageIds) remove.run(id);
}
export function isBlocked(db: Database, messageId: string): boolean {
	return (
		db
			.query("SELECT 1 FROM memory_message_block WHERE message_id = ?")
			.get(messageId) != null
	);
}
/** The blocked ones among the ids. */
export function blockedAmong(
	db: Database,
	messageIds: Iterable<string>,
): Set<string> {
	const blocked = new Set<string>();
	const query = db.query(
		"SELECT 1 FROM memory_message_block WHERE message_id = ?",
	);
	for (const id of new Set(messageIds)) if (query.get(id)) blocked.add(id);
	return blocked;
}
/** Every blocked message of a conversation (the exclusion list of a recall); blocks of '' (migrated, no conversation known) apply to all. */
export function blockedInConversation(
	db: Database,
	conversationId: string,
): string[] {
	return (
		db
			.query(
				"SELECT message_id AS id FROM memory_message_block WHERE conversation_id IN (?, '')",
			)
			.all(conversationId) as Array<{ id: string }>
	).map((row) => row.id);
}

// ---- block journal lines already applied ----

export function isBlockApplied(db: Database, forgetId: string): boolean {
	return (
		db
			.query("SELECT 1 FROM memory_block_applied WHERE forget_id = ?")
			.get(forgetId) != null
	);
}
export function markBlockApplied(db: Database, forgetId: string, now: string) {
	db.query(
		"INSERT OR IGNORE INTO memory_block_applied (forget_id, applied_at) VALUES (?,?)",
	).run(forgetId, now);
}

// ---- forget fence ----

export function readForgetSeq(db: Database): number {
	return (
		db.query("SELECT seq FROM memory_forget_fence WHERE id = 1").get() as {
			seq: number;
		}
	).seq;
}
export function bumpForgetSeq(db: Database): number {
	db.query("UPDATE memory_forget_fence SET seq = seq + 1 WHERE id = 1").run();
	return readForgetSeq(db);
}
