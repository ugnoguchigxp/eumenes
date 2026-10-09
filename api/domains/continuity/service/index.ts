import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type {
	AddContinuity,
	ContinuityItem,
	ContinuitySnapshot,
	ContinuityTransition,
} from "../contracts";
import {
	conversationRevision,
	getItem,
	insertItem,
	listItems,
	transitionItem,
} from "../repository";

export function createContinuityService(
	store: SqliteStore,
	clock: () => string = () => new Date().toISOString(),
	id: () => string = () => crypto.randomUUID(),
) {
	return {
		add(conversationId: string, input: AddContinuity): Promise<ContinuityItem> {
			return store.write((db) => {
				const now = clock();
				const item: ContinuityItem = {
					id: id(),
					conversationId,
					kind: input.kind,
					text: input.text,
					status: "active",
					revision: 1,
					createdAt: now,
					updatedAt: now,
				};
				insertItem(db, item);
				return item;
			});
		},
		transition(
			itemId: string,
			input: ContinuityTransition,
		): Promise<ContinuityItem> {
			return store.write((db) => {
				const existing = getItem(db, itemId);
				if (!existing) throw new Error("invalid_continuity_item");
				if (
					!transitionItem(
						db,
						itemId,
						input.expectedRevision,
						input.status,
						clock(),
					)
				)
					throw new Error("revision_conflict");
				return getItem(db, itemId) as ContinuityItem;
			});
		},
		list(conversationId: string, includeClosed = false): ContinuityItem[] {
			return store.read((db) => listItems(db, conversationId, !includeClosed));
		},
		/** Same-transaction read so an adoption check sees what the writer will commit. */
		snapshotInTransaction(
			db: Database,
			conversationId: string,
		): ContinuitySnapshot {
			return {
				revision: conversationRevision(db, conversationId),
				items: listItems(db, conversationId, true),
			};
		},
	};
}
export type ContinuityService = ReturnType<typeof createContinuityService>;
