import type { Database } from "bun:sqlite";
import type { ConversationService } from "../../conversation";
import { deleteTurnVectors } from "../repository";

/**
 * What follows a message retraction (run inside it, before the message is tombstoned): the vectors of the
 * message and of its exchange partner are dropped, so neither the digest nor the meaning of the removed text
 * stays recallable.
 */
export function dropVectorsOnRetract(conversation: ConversationService) {
	return (db: Database, messageId: string) => {
		const found = conversation.messageInTransaction(db, messageId);
		const runId = found?.message.runId;
		deleteTurnVectors(db, [
			messageId,
			...(found && runId
				? conversation
						.messagesOfRunInTransaction(db, found.message.conversationId, runId)
						.map(({ message }) => message.id)
				: []),
		]);
	};
}
