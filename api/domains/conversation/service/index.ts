import { createAttachments } from "./attachments";
import { linkAttachments } from "../repository/attachments";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { AvatarMotion, SpeechDelivery } from "../../delivery";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	type ChangeResult,
	type Conversation,
	type ConversationSourceState,
	type Message,
	type OutboxEvent,
} from "../contracts";
import {
	appendMessage,
	correctMessage,
	ensureConversation,
	getMessage,
	latestOrdinal,
	listMessages,
	messageWithDelivery,
	messagesAfter,
	messagesOfRun,
	messagesBefore,
	nthLatestUserOrdinal,
	tailMessages,
	listOutbox,
	outboxReady,
	retractionReady,
	revision,
	recordAnswerMotion,
	recordAnswerDelivery,
	retractMessage,
	sourceState,
	type OutboxOptions,
} from "../repository";

import { createHistory } from "./history";
import type { HistoryOwner } from "../contracts/history";

/** Upper bound of messages returned by `get` (newest kept). */
const GET_MESSAGE_LIMIT = 200;

export type ConversationServiceOptions = {
	/** Principal / scope recorded on outbox events and source states. */
	principal?: string;
	scopeKey?: string;
	/** Fail instead of skipping the outbox when its migration is missing. */
	requireOutbox?: boolean;
	clock?: () => string;
};

export function createConversationService(
	store: SqliteStore,
	serviceOptions: ConversationServiceOptions = {},
) {
	const outbox: OutboxOptions = {
		principal: serviceOptions.principal ?? CONVERSATION_DEFAULT_PRINCIPAL,
		scopeKey: serviceOptions.scopeKey ?? CONVERSATION_DEFAULT_SCOPE,
		required: serviceOptions.requireOutbox ?? false,
	};
	const clock = serviceOptions.clock ?? (() => new Date().toISOString());
	const history = createHistory(() => Date.parse(clock()), outbox);
	const apiOwner = (conversationId: string): HistoryOwner => ({
		key: "api:local:owner",
		conversationId,
		deadline: Date.parse(clock()) + 900000,
	});
	const correctInTransaction = (
		db: Database,
		input: { messageId: string; text: string; at?: string },
	): ChangeResult =>
		correctMessage(
			db,
			{ messageId: input.messageId, text: input.text, at: input.at ?? clock() },
			outbox,
		);
	/** Called inside every retraction, before the message is tombstoned (each higher domain drops what it derived from it). */
	const retractHooks: Array<(db: Database, messageId: string) => void> = [];
	const retractInTransaction = (
		db: Database,
		input: { messageId: string; at?: string },
	): ChangeResult => {
		for (const hook of retractHooks) hook(db, input.messageId);
		return retractMessage(
			db,
			{ messageId: input.messageId, at: input.at ?? clock() },
			outbox,
		);
	};
	return {
		...createAttachments(store, outbox.principal),
		historyFingerprintInTransaction: history.fingerprint,
		historySearchInTransaction: history.search,
		historyReadInTransaction: history.read,
		validateHistoryInTransaction: history.validate,
		releaseHistory: history.release,
		searchHistory(id: string, raw: unknown) {
			return store.readSnapshot((db) => history.search(db, apiOwner(id), raw));
		},
		readHistory(id: string, raw: unknown) {
			return store.readSnapshot((db) => history.read(db, apiOwner(id), raw));
		},
		/** True when the outbox migration is applied to this connection. */
		outboxReadyInTransaction(db: Database): boolean {
			return outboxReady(db);
		},
		/** Explicit correction of a confirmed message; source write + event in one transaction. */
		correctInTransaction,
		correct(input: {
			messageId: string;
			text: string;
			at?: string;
		}): Promise<ChangeResult> {
			return store.write((db) => correctInTransaction(db, input));
		},
		/**
		 * Adds a function run in the transaction of every retraction, while the message can still be read.
		 * Conversation imports nothing of its users: each injects what must follow a retraction.
		 */
		addRetractHook(hook: (db: Database, messageId: string) => void) {
			retractHooks.push(hook);
		},
		/** True when the retraction tombstone column exists on this connection. */
		retractionReadyInTransaction(db: Database): boolean {
			return retractionReady(db);
		},
		/** Explicit retraction of a confirmed message; the text is removed (tombstoned). */
		retractInTransaction,
		retract(input: { messageId: string; at?: string }): Promise<ChangeResult> {
			return store.write((db) => retractInTransaction(db, input));
		},
		/** Outbox events after `after` (exclusive), oldest first. Gaps in seq are normal. */
		changesInTransaction(
			db: Database,
			after: number,
			limit: number,
		): OutboxEvent[] {
			return listOutbox(db, after, limit);
		},
		/** Current source state of a message: available / retracted / missing. */
		sourceInTransaction(db: Database, id: string): ConversationSourceState {
			return sourceState(db, id, outbox);
		},
		recordAnswerMotionInTransaction(
			db: Database,
			runId: string,
			conversationId: string,
			motion: AvatarMotion,
		) {
			return recordAnswerMotion(db, runId, conversationId, motion);
		},
		recordAnswerDeliveryInTransaction(
			db: Database,
			runId: string,
			conversationId: string,
			delivery: SpeechDelivery,
		) {
			return recordAnswerDelivery(db, runId, conversationId, delivery);
		},
		get(id: string): Conversation {
			return store.read((db) => {
				const { messages, hasMore } = tailMessages(db, id, GET_MESSAGE_LIMIT);
				return {
					id,
					revision: revision(db, id),
					messages,
					...(hasMore ? { hasMore: true } : {}),
				};
			});
		},
		message(id: string): Message | null {
			return store.read((db) => messageWithDelivery(db, id));
		},
		/** Up to `limit` messages accepted before `messageId`, oldest first. */
		turnsBefore(
			conversationId: string,
			messageId: string,
			limit: number,
		): Message[] {
			return store.read((db) => {
				const at = getMessage(db, messageId);
				return at ? messagesBefore(db, conversationId, at.ordinal, limit) : [];
			});
		},
		messagesInTransaction(db: Database, id: string): Message[] {
			return listMessages(db, id);
		},
		messageInTransaction(db: Database, id: string) {
			return getMessage(db, id);
		},
		/** Live messages accepted after `afterOrdinal`, oldest first, with their ordinals (the memory agent's cursor). */
		messagesAfterInTransaction(
			db: Database,
			conversationId: string,
			afterOrdinal: number,
			limit: number,
		) {
			return messagesAfter(db, conversationId, afterOrdinal, limit);
		},
		/** The live messages one run produced (input and adopted answer), oldest first, with their ordinals. */
		messagesOfRunInTransaction(
			db: Database,
			conversationId: string,
			runId: string,
		) {
			return messagesOfRun(db, conversationId, runId);
		},
		/** The ordinal of the conversation's newest live message; 0 when it has none. */
		latestOrdinalInTransaction(db: Database, conversationId: string): number {
			return latestOrdinal(db, conversationId);
		},
		/** The ordinal of the n-th newest live user message (1 = newest); 0 when there are fewer. */
		nthLatestUserOrdinalInTransaction(
			db: Database,
			conversationId: string,
			n: number,
		): number {
			return nthLatestUserOrdinal(db, conversationId, n);
		},
		appendInTransaction(db: Database, message: Message): number {
			ensureConversation(db, message.conversationId, message.createdAt);
			const result = appendMessage(db, message, outbox);
			if (message.attachments?.length)
				linkAttachments(
					db,
					message.id,
					message.attachments.map((a) => a.id),
					outbox.principal,
					message.conversationId,
				);
			return result;
		},
		append(message: Message): Promise<number> {
			return store.write((db) => {
				ensureConversation(db, message.conversationId, message.createdAt);
				const result = appendMessage(db, message, outbox);
				if (message.attachments?.length)
					linkAttachments(
						db,
						message.id,
						message.attachments.map((a) => a.id),
						outbox.principal,
						message.conversationId,
					);
				return result;
			});
		},
	};
}
export type ConversationService = ReturnType<typeof createConversationService>;
