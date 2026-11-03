import type { SqliteStore } from "../../../infrastructure/sqlite";
import { createContinuityService } from "..";
import { listItems, conversationRevision } from "../repository";
/** Read conveniences for the domain fixtures; production reads in its own transaction. */
export function createContinuityFixture(
	store: SqliteStore,
	...args: Parameters<typeof createContinuityService>
) {
	const service = createContinuityService(...args);
	return {
		...service,
		list(conversationId: string, includeClosed = false) {
			return store.read((db) => listItems(db, conversationId, !includeClosed));
		},
		revisionInTransaction: conversationRevision,
		snapshot(conversationId: string) {
			return store.read((db) =>
				service.snapshotInTransaction(db, conversationId),
			);
		},
	};
}
