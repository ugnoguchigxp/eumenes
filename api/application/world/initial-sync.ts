import type { ConversationService } from "../../domains/conversation";
import type { SqliteStore } from "../../infrastructure/sqlite";

/** A bounded pass over source-owned history. Its outbox rows make interruption/retry idempotent. */
export async function backfillConversationSources(options: {
	store: SqliteStore;
	conversation: ConversationService;
	maxPages: number;
	closed: () => boolean;
}): Promise<string | null> {
	let after = 0;
	for (let page = 0; page < options.maxPages; page++) {
		if (options.closed()) return "CLOSED";
		const result = await options.store.write((db) =>
			options.conversation.backfillSourceEventsInTransaction(db, after),
		);
		after = result.after;
		if (!result.hasMore) return null;
	}
	return "PAGE_LIMIT";
}
