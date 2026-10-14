import type { Database } from "bun:sqlite";

/**
 * The ledgers the steward works from: exchanges and their step marks, the conversation summary and its
 * sources, the blocked messages, and the forget fence. Row shapes live in `memory/0005-steward-ledgers`.
 */

type ExchangeOutcome = "answered" | "failed";
export type ExchangeStep = "curated" | "disposed" | "summarized";
export type StepMark = "done" | "skipped";
export type Disposition = "keep" | "summarize" | "drop";
export type BlockReason = "scheduled_prompt" | "forgotten";

export interface ExchangeRow {
	inputMessageId: string;
	conversationId: string;
	runId: string;
	answerMessageId: string | null;
	outcome: ExchangeOutcome;
	inputOrdinal: number;
	answerOrdinal: number | null;
	state: "pending" | "done";
	curated: StepMark | null;
	disposed: StepMark | null;
	summarized: StepMark | null;
	disposition: Disposition | null;
	duplicateOf: string | null;
	/** Failed attempts per step name (the steward's own count). */
	failures: Record<string, number>;
	createdAt: string;
	updatedAt: string;
}

const exchangeColumns = `input_message_id AS inputMessageId, conversation_id AS conversationId, run_id AS runId,
 answer_message_id AS answerMessageId, outcome, input_ordinal AS inputOrdinal, answer_ordinal AS answerOrdinal,
 state, curated, disposed, summarized, disposition, duplicate_of AS duplicateOf, failures,
 created_at AS createdAt, updated_at AS updatedAt`;
function mapExchange(row: Record<string, unknown>): ExchangeRow {
	return {
		...(row as unknown as Omit<ExchangeRow, "failures">),
		failures: JSON.parse(row.failures as string) as Record<string, number>,
	};
}

// ---- exchanges ----

/** False when the exchange was already registered (the first registration stands). */
export function insertExchange(db: Database, row: ExchangeRow): boolean {
	return (
		db
			.query(
				`INSERT OR IGNORE INTO memory_exchange (input_message_id, conversation_id, run_id, answer_message_id, outcome,
				 input_ordinal, answer_ordinal, state, curated, disposed, summarized, disposition, duplicate_of, failures, created_at, updated_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				row.inputMessageId,
				row.conversationId,
				row.runId,
				row.answerMessageId,
				row.outcome,
				row.inputOrdinal,
				row.answerOrdinal,
				row.state,
				row.curated,
				row.disposed,
				row.summarized,
				row.disposition,
				row.duplicateOf,
				JSON.stringify(row.failures),
				row.createdAt,
				row.updatedAt,
			).changes === 1
	);
}
export function readExchange(
	db: Database,
	inputMessageId: string,
): ExchangeRow | null {
	const row = db
		.query(
			`SELECT ${exchangeColumns} FROM memory_exchange WHERE input_message_id = ?`,
		)
		.get(inputMessageId) as Record<string, unknown> | null;
	return row ? mapExchange(row) : null;
}
/** Every exchange of a conversation, oldest first. */
export function listExchanges(
	db: Database,
	conversationId: string,
): ExchangeRow[] {
	return (
		db
			.query(
				`SELECT ${exchangeColumns} FROM memory_exchange WHERE conversation_id = ? ORDER BY input_ordinal`,
			)
			.all(conversationId) as Record<string, unknown>[]
	).map(mapExchange);
}
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM memory_message_block b WHERE b.message_id = memory_exchange.input_message_id
 OR b.message_id = memory_exchange.answer_message_id)`;
/** Exchanges still waiting for a step, oldest first; exchanges with a blocked message are never offered. */
export function pendingExchanges(
	db: Database,
	conversationId: string,
	step: ExchangeStep,
	limit: number,
): ExchangeRow[] {
	// `summarized` is only wanted for exchanges the dispose step sent to the summary.
	const wanted =
		step === "summarized"
			? "summarized IS NULL AND disposition = 'summarize'"
			: `${step} IS NULL`;
	return (
		db
			.query(
				`SELECT ${exchangeColumns} FROM memory_exchange
				 WHERE conversation_id = ? AND state = 'pending' AND ${wanted} AND ${NOT_BLOCKED}
				 ORDER BY input_ordinal LIMIT ?`,
			)
			.all(conversationId, limit) as Record<string, unknown>[]
	).map(mapExchange);
}
/** An exchange is done when all three step marks are set; otherwise it is pending. */
function settleState(db: Database, inputMessageId: string, now: string) {
	db.query(
		`UPDATE memory_exchange SET updated_at = ?,
		 state = CASE WHEN curated IS NOT NULL AND disposed IS NOT NULL AND summarized IS NOT NULL THEN 'done' ELSE 'pending' END
		 WHERE input_message_id = ?`,
	).run(now, inputMessageId);
}
export function setExchangeMark(
	db: Database,
	inputMessageId: string,
	step: ExchangeStep,
	mark: StepMark,
	now: string,
): boolean {
	const result = db
		.query(`UPDATE memory_exchange SET ${step} = ? WHERE input_message_id = ?`)
		.run(mark, inputMessageId);
	if (result.changes !== 1) return false;
	settleState(db, inputMessageId, now);
	return true;
}
/**
 * The dispose step's verdict. Only `summarize` leaves work for the summarize step, so `keep` and `drop` close it
 * (`summarized = done` unless a mark is already there); the exchange is done once all three steps are marked.
 */
export function setExchangeDisposition(
	db: Database,
	inputMessageId: string,
	disposition: Disposition,
	duplicateOf: string | null,
	now: string,
): boolean {
	const result = db
		.query(
			"UPDATE memory_exchange SET disposition = ?, duplicate_of = ? WHERE input_message_id = ?",
		)
		.run(disposition, duplicateOf, inputMessageId);
	if (result.changes !== 1) return false;
	if (disposition !== "summarize")
		db.query(
			"UPDATE memory_exchange SET summarized = COALESCE(summarized, 'done') WHERE input_message_id = ?",
		).run(inputMessageId);
	settleState(db, inputMessageId, now);
	return true;
}
/** One more failed attempt of a step; returns the count. */
export function bumpExchangeFailure(
	db: Database,
	inputMessageId: string,
	step: string,
	now: string,
): number {
	const row = readExchange(db, inputMessageId);
	if (!row) return 0;
	const count = (row.failures[step] ?? 0) + 1;
	db.query(
		"UPDATE memory_exchange SET failures = ?, updated_at = ? WHERE input_message_id = ?",
	).run(
		JSON.stringify({ ...row.failures, [step]: count }),
		now,
		inputMessageId,
	);
	return count;
}
/** Every pending exchange gets `skipped` on the steps it has no mark for (what was said while memory was off). */
export function skipPendingExchanges(db: Database, now: string) {
	db.query(
		`UPDATE memory_exchange SET
		 curated = COALESCE(curated, 'skipped'), disposed = COALESCE(disposed, 'skipped'),
		 summarized = COALESCE(summarized, 'skipped'), state = 'done', updated_at = ?
		 WHERE state = 'pending'`,
	).run(now);
}
/** Exchanges whose input or answer is one of the messages (a forget drops them from every layer). */
export function dropExchangesOfMessages(
	db: Database,
	messageIds: readonly string[],
	now: string,
) {
	const drop = db.query(
		`UPDATE memory_exchange SET disposition = 'drop', updated_at = ?
		 WHERE input_message_id = ? OR answer_message_id = ?`,
	);
	for (const id of messageIds) drop.run(now, id, id);
}

// ---- conversation summary ----

export interface SummaryRow {
	conversationId: string;
	text: string;
	revision: number;
	updatedAt: string;
	/** Input message ids of the exchanges the text stands on. */
	sources: string[];
}
export function readSummaryRevision(
	db: Database,
	conversationId: string,
): number {
	return (
		(
			db
				.query(
					"SELECT revision FROM memory_conversation_summary WHERE conversation_id = ?",
				)
				.get(conversationId) as { revision: number } | null
		)?.revision ?? 0
	);
}
export function readSummary(
	db: Database,
	conversationId: string,
): SummaryRow | null {
	const row = db
		.query(
			"SELECT text, revision, updated_at AS updatedAt FROM memory_conversation_summary WHERE conversation_id = ?",
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
				"SELECT input_message_id AS id FROM memory_summary_source WHERE conversation_id = ? AND revision = ? ORDER BY input_message_id",
			)
			.all(conversationId, row.revision) as Array<{ id: string }>
	).map((source) => source.id);
	return { conversationId, ...row, sources };
}
/** Replaces the summary with the next revision and its sources (older revisions' source rows go). */
export function writeSummary(
	db: Database,
	conversationId: string,
	text: string,
	sources: readonly string[],
	now: string,
): number {
	const revision = readSummaryRevision(db, conversationId) + 1;
	db.query(
		`INSERT INTO memory_conversation_summary (conversation_id, text, revision, updated_at) VALUES (?,?,?,?)
		 ON CONFLICT(conversation_id) DO UPDATE SET text = excluded.text, revision = excluded.revision, updated_at = excluded.updated_at`,
	).run(conversationId, text, revision, now);
	db.query(
		"DELETE FROM memory_summary_source WHERE conversation_id = ? AND revision < ?",
	).run(conversationId, revision);
	const insert = db.query(
		"INSERT OR IGNORE INTO memory_summary_source (conversation_id, revision, input_message_id) VALUES (?,?,?)",
	);
	for (const source of sources) insert.run(conversationId, revision, source);
	return revision;
}
/** The conversations whose current summary stands on one of these input messages. */
export function conversationsSummarizing(
	db: Database,
	inputMessageIds: readonly string[],
): string[] {
	const found = new Set<string>();
	const query = db.query(
		`SELECT s.conversation_id AS id FROM memory_summary_source s
		 JOIN memory_conversation_summary c ON c.conversation_id = s.conversation_id AND c.revision = s.revision
		 WHERE s.input_message_id = ?`,
	);
	for (const messageId of inputMessageIds)
		for (const row of query.all(messageId) as Array<{ id: string }>)
			found.add(row.id);
	return [...found];
}
export function deleteSummary(db: Database, conversationId: string) {
	db.query("DELETE FROM memory_summary_source WHERE conversation_id = ?").run(
		conversationId,
	);
	db.query(
		"DELETE FROM memory_conversation_summary WHERE conversation_id = ?",
	).run(conversationId);
}
/** Back to "not yet summarized" for the exchanges a deleted summary stood on (they stay verbatim until rewritten). */
export function resetSummarized(
	db: Database,
	inputMessageIds: readonly string[],
	now: string,
) {
	const reset = db.query(
		`UPDATE memory_exchange SET summarized = NULL, state = 'pending', updated_at = ?
		 WHERE input_message_id = ? AND disposition = 'summarize'`,
	);
	for (const id of inputMessageIds) reset.run(now, id);
}

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
/** Every blocked message of a conversation (the exclusion list of a recall). */
export function blockedInConversation(
	db: Database,
	conversationId: string,
): string[] {
	return (
		db
			.query(
				"SELECT message_id AS id FROM memory_message_block WHERE conversation_id = ?",
			)
			.all(conversationId) as Array<{ id: string }>
	).map((row) => row.id);
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
