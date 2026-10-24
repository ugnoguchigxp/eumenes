import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ContinuityService } from "../../continuity";
import type { BlockReason } from "../contracts";
import {
	blockedAmong,
	blockedInConversation,
	deleteSpecialistBlocks,
	insertBlocks,
	isBlocked,
	readForgetSeq,
} from "../repository";

/**
 * The block ledger (messages that are neither learned from nor shown to the conversation) and the forget fence:
 * what the dialogue and the steward read and write. Everything here runs in the caller's writer transaction
 * except the plain reads. What the conversation said is the continuity event flow; memory does not keep a ledger
 * of it.
 */
export function createLedger(deps: {
	store: SqliteStore;
	continuity: ContinuityService;
	clock: () => string;
	/**
	 * The message ids of the block journal (held in process). While memory is unhealthy the database may lack
	 * a block the journal has, so the answers about blocked messages include these too.
	 */
	journalBlocked: ReadonlySet<string>;
}) {
	const { store, continuity, clock, journalBlocked } = deps;
	const blockedWithJournal = (
		db: Database,
		messageIds: Iterable<string>,
	): Set<string> => {
		const ids = [...messageIds];
		const blocked = blockedAmong(db, ids);
		for (const id of ids) if (journalBlocked.has(id)) blocked.add(id);
		return blocked;
	};

	return {
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
		/**
		 * A scheduled prompt (a user message the user did not write) and a specialist session's messages
		 * are never learned from nor shown to the conversation. This is not a forget: the conversation's events
		 * (the continuity flow) are left as they are.
		 */
		blockMessagesInTransaction(
			db: Database,
			input: {
				conversationId: string;
				messageIds: readonly string[];
				reason: Extract<
					BlockReason,
					"scheduled_prompt" | "specialist_dialogue"
				>;
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
		/**
		 * Hand specialist messages back to the conversation (the user's out-of-scope request forwarded to
		 * the main agent): only the specialist-dialogue block is lifted, a forgotten message stays blocked.
		 */
		unblockSpecialistMessagesInTransaction(
			db: Database,
			messageIds: readonly string[],
		) {
			deleteSpecialistBlocks(db, messageIds);
		},
		/** The forget fence: it moves with every forget; a step that started before a move is not adopted. */
		forgetSeqInTransaction: (db: Database): number => readForgetSeq(db),
		/**
		 * What was said while memory was off (or unhealthy) is never learned: every event the steward has not
		 * handled yet is marked handled, so it is not offered later.
		 */
		skipUncuratedEventsInTransaction(db: Database) {
			for (const conversationId of continuity.events.conversationsWithUncuratedInTransaction(
				db,
			)) {
				const seqs = continuity.events
					.uncuratedInTransaction(db, conversationId)
					.map((event) => event.seq);
				continuity.events.markCuratedInTransaction(db, conversationId, seqs);
			}
		},
	};
}
