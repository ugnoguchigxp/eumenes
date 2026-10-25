import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { ContinuityService } from "../../domains/continuity";
import type { ConversationService } from "../../domains/conversation";
import { invalidateMessageSource, maintainMessages } from "../../domains/dots";
export function createMessageLifecycle(input: {
	store: SqliteStore;
	conversation: ConversationService;
	continuity: ContinuityService;
	now: () => number;
}) {
	const { store, conversation, now } = input;
	function retract(db: Database, ids: string[], except?: string) {
		input.continuity.events.forgetMessagesInTransaction(
			db,
			ids,
			new Date(now()).toISOString(),
		);
		for (const id of ids)
			if (id !== except)
				conversation.retractInTransaction(db, {
					messageId: id,
					at: new Date(now()).toISOString(),
				});
	}
	return {
		invalidateMessageInTransaction(db: Database, id: string) {
			retract(db, invalidateMessageSource(db, id, now()), id);
		},
		maintenance: () =>
			store.write((db) => {
				retract(db, maintainMessages(db, now()));
			}),
	};
}
