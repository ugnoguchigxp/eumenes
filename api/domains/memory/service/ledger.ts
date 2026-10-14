import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type {
	BlockReason,
	Disposition,
	ExchangeDto,
	ExchangeStep,
	RecordExchangeInput,
	StepMark,
	SummaryDto,
} from "../contracts";
import {
	blockedAmong,
	blockedInConversation,
	bumpExchangeFailure,
	insertBlocks,
	insertExchange,
	isBlocked,
	listExchanges,
	pendingConversationIds,
	pendingExchanges,
	readExchange,
	readForgetSeq,
	readSummary,
	readSummaryRevision,
	setExchangeDisposition,
	setExchangeMark,
	skipPendingExchanges,
	writeSummary,
} from "../repository";

/** The summary text the steward may store (characters). */
export const SUMMARY_MAX_CHARS = 1200;

/**
 * The exchange ledger, the conversation summary and the blocked messages: what the steward and the dialogue read
 * and write. Everything here runs in the caller's writer transaction except the plain reads.
 */
export function createLedger(deps: {
	store: SqliteStore;
	conversation: ConversationService;
	clock: () => string;
	/** Memory is switched on and healthy: what is said while it is not is never learned. */
	active: (db: Database) => boolean;
	/**
	 * The message ids of the block journal (held in process). While memory is unhealthy the database may lack
	 * a block the journal has, so the answers about blocked messages include these too.
	 */
	journalBlocked: ReadonlySet<string>;
}) {
	const { store, conversation, clock, journalBlocked } = deps;
	const blockedWithJournal = (
		db: Database,
		messageIds: Iterable<string>,
	): Set<string> => {
		const ids = [...messageIds];
		const blocked = blockedAmong(db, ids);
		for (const id of ids) if (journalBlocked.has(id)) blocked.add(id);
		return blocked;
	};

	function recordExchangeInTransaction(
		db: Database,
		input: RecordExchangeInput,
	): { registered: boolean } {
		const user = conversation.messageInTransaction(db, input.inputMessageId);
		if (
			!user ||
			user.message.role !== "user" ||
			user.message.conversationId !== input.conversationId
		)
			throw new Error("invalid_exchange");
		let answerOrdinal: number | null = null;
		if (input.answerMessageId !== null) {
			const answer = conversation.messageInTransaction(
				db,
				input.answerMessageId,
			);
			if (
				!answer ||
				answer.message.role !== "assistant" ||
				answer.message.conversationId !== input.conversationId
			)
				throw new Error("invalid_exchange");
			answerOrdinal = answer.ordinal;
		}
		if ((input.answerMessageId === null) !== (input.outcome === "failed"))
			throw new Error("invalid_exchange");
		// A scheduled prompt is stored as a user message but is not the user's word.
		if (isBlocked(db, input.inputMessageId)) return { registered: false };
		const now = clock();
		// While memory is off or unhealthy the exchange is kept for the context but never learned from.
		const learnable = deps.active(db);
		const mark: StepMark | null = learnable ? null : "skipped";
		return {
			registered: insertExchange(db, {
				inputMessageId: input.inputMessageId,
				conversationId: input.conversationId,
				runId: input.runId,
				answerMessageId: input.answerMessageId,
				outcome: input.outcome,
				inputOrdinal: user.ordinal,
				answerOrdinal,
				state: learnable ? "pending" : "done",
				curated: mark,
				disposed: mark,
				summarized: mark,
				disposition: null,
				duplicateOf: null,
				failures: {},
				createdAt: now,
				updatedAt: now,
			}),
		};
	}

	return {
		recordExchangeInTransaction,
		/** Exchanges still waiting for a step, oldest first; exchanges touching a blocked message are never offered. */
		pendingExchangesInTransaction: (
			db: Database,
			conversationId: string,
			step: ExchangeStep,
			limit: number,
		): ExchangeDto[] => pendingExchanges(db, conversationId, step, limit),
		/** The conversations that have exchanges waiting for a step. */
		pendingConversationIdsInTransaction: (db: Database): string[] =>
			pendingConversationIds(db),
		exchangeInTransaction: (
			db: Database,
			inputMessageId: string,
		): ExchangeDto | null => readExchange(db, inputMessageId),
		exchangesInTransaction: (
			db: Database,
			conversationId: string,
		): ExchangeDto[] => listExchanges(db, conversationId),
		/** The ledger of a conversation (read-only). */
		exchanges: (conversationId: string): ExchangeDto[] =>
			store.read((db) => listExchanges(db, conversationId)),
		/** done or skipped on one step; the exchange is `done` once all three steps are marked. false: no such exchange. */
		markExchangeStepInTransaction(
			db: Database,
			inputMessageId: string,
			step: ExchangeStep,
			mark: StepMark,
		): boolean {
			return setExchangeMark(db, inputMessageId, step, mark, clock());
		},
		/** One more failed attempt of a step on the exchange (the steward's count); returns the new count. */
		recordExchangeFailureInTransaction: (
			db: Database,
			inputMessageId: string,
			step: ExchangeStep,
		): number => bumpExchangeFailure(db, inputMessageId, step, clock()),
		/**
		 * The dispose step's verdict (`duplicateOf`: the input message id of the earlier exchange this repeats).
		 * `keep` and `drop` need no summary, so they also close the summarize step.
		 */
		setDispositionInTransaction(
			db: Database,
			inputMessageId: string,
			disposition: Disposition,
			duplicateOf: string | null = null,
		): boolean {
			return setExchangeDisposition(
				db,
				inputMessageId,
				disposition,
				duplicateOf,
				clock(),
			);
		},
		/** The conversation's summary with its sources and revision; null when it has none. */
		summaryInTransaction: (
			db: Database,
			conversationId: string,
		): SummaryDto | null => readSummary(db, conversationId),
		/** 0: no summary yet. */
		summaryRevisionInTransaction: (db: Database, conversationId: string) =>
			readSummaryRevision(db, conversationId),
		/**
		 * Writes the next summary. Its sources are the previous revision's sources plus `included` (input message ids of
		 * the exchanges of this conversation), minus blocked ones, written in this transaction; the included exchanges
		 * become `summarize` and `summarized: done`. `expectedRevision` (0: none yet) guards against a rewrite based on
		 * an older summary.
		 */
		writeSummaryInTransaction(
			db: Database,
			input: {
				conversationId: string;
				text: string;
				included: readonly string[];
				expectedRevision: number;
			},
		):
			| { ok: true; revision: number; included: string[]; sources: string[] }
			| { ok: false; reason: "stale_revision" | "invalid_summary" } {
			const text = input.text.trim();
			if (text === "" || [...text].length > SUMMARY_MAX_CHARS)
				return { ok: false, reason: "invalid_summary" };
			if (
				readSummaryRevision(db, input.conversationId) !== input.expectedRevision
			)
				return { ok: false, reason: "stale_revision" };
			const blocked = blockedAmong(db, input.included);
			const included = [...new Set(input.included)].filter((id) => {
				const row = readExchange(db, id);
				return (
					row !== null &&
					row.conversationId === input.conversationId &&
					!blocked.has(id) &&
					(row.answerMessageId === null || !isBlocked(db, row.answerMessageId))
				);
			});
			const previous = readSummary(db, input.conversationId)?.sources ?? [];
			const previousBlocked = blockedAmong(db, previous);
			const sources = [
				...new Set([
					...previous.filter((id) => !previousBlocked.has(id)),
					...included,
				]),
			];
			const now = clock();
			const revision = writeSummary(
				db,
				input.conversationId,
				text,
				sources,
				now,
			);
			for (const id of included) {
				setExchangeDisposition(db, id, "summarize", null, now);
				setExchangeMark(db, id, "summarized", "done", now);
			}
			return { ok: true, revision, included, sources };
		},
		/** The blocked ones among these messages. */
		blockedMessageIdsInTransaction: (
			db: Database,
			messageIds: Iterable<string>,
		): Set<string> => blockedWithJournal(db, messageIds),
		isBlockedInTransaction: (db: Database, messageId: string): boolean =>
			isBlocked(db, messageId) || journalBlocked.has(messageId),
		/** Every blocked message of the conversation (the exclusion list of a recall), and the block journal's. */
		blockedMessageIdsOfConversationInTransaction: (
			db: Database,
			conversationId: string,
		): string[] => [
			...new Set([
				...blockedInConversation(db, conversationId),
				...journalBlocked,
			]),
		],
		/** Read-only form for the application layer (research tools). */
		blockedMessageIds: (messageIds: Iterable<string>): Set<string> =>
			store.read((db) => blockedWithJournal(db, messageIds)),
		/** A scheduled prompt (a user message the user did not write) is never learned from. */
		blockMessagesInTransaction(
			db: Database,
			input: {
				conversationId: string;
				messageIds: readonly string[];
				reason: Extract<BlockReason, "scheduled_prompt">;
			},
		) {
			insertBlocks(
				db,
				input.messageIds.map((messageId) => ({
					messageId,
					conversationId: input.conversationId,
					reason: input.reason,
					forgetId: null,
				})),
				clock(),
			);
		},
		/** The forget fence: it moves with every forget; a step that started before a move is not adopted. */
		forgetSeqInTransaction: (db: Database): number => readForgetSeq(db),
		/** What was said while memory was off (or unhealthy) is never learned: pending exchanges are marked skipped. */
		skipPendingExchangesInTransaction(db: Database) {
			skipPendingExchanges(db, clock());
		},
	};
}
