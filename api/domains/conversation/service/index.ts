import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Conversation, Message } from "../contracts";
import {
	appendMessage,
	ensureConversation,
	listMessages,
	revision,
} from "../repository";

export function createConversationService(store: SqliteStore) {
	return {
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
		appendInTransaction(db: Database, message: Message): number {
			ensureConversation(db, message.conversationId, message.createdAt);
			return appendMessage(db, message);
		},
		append(message: Message): Promise<number> {
			return store.write((db) => {
				ensureConversation(db, message.conversationId, message.createdAt);
				return appendMessage(db, message);
			});
		},
	};
}
export type ConversationService = ReturnType<typeof createConversationService>;
