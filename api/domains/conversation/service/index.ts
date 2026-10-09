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
	listMessages,
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
	const correctInTransaction = (
		db: Database,
		input: { messageId: string; text: string; at?: string },
	): ChangeResult =>
		correctMessage(
			db,
			{ messageId: input.messageId, text: input.text, at: input.at ?? clock() },
			outbox,
		);
	const retractInTransaction = (
		db: Database,
		input: { messageId: string; at?: string },
	): ChangeResult =>
		retractMessage(
			db,
			{ messageId: input.messageId, at: input.at ?? clock() },
			outbox,
		);
	return {
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
			return store.read((db) => ({
				id,
				revision: revision(db, id),
				messages: listMessages(db, id),
			}));
		},
		messagesInTransaction(db: Database, id: string): Message[] {
			return listMessages(db, id);
		},
		messageInTransaction(db: Database, id: string) {
			return getMessage(db, id);
		},
		appendInTransaction(db: Database, message: Message): number {
			ensureConversation(db, message.conversationId, message.createdAt);
			return appendMessage(db, message, outbox);
		},
		append(message: Message): Promise<number> {
			return store.write((db) => {
				ensureConversation(db, message.conversationId, message.createdAt);
				return appendMessage(db, message, outbox);
			});
		},
	};
}
export type ConversationService = ReturnType<typeof createConversationService>;
