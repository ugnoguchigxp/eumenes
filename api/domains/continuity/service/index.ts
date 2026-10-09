import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { MAX_ACTIVE_CONTINUITY } from "../contracts";
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
	/** Runs inside the write transaction after an item is added; throwing rolls the add back. */
	let guard: ((db: Database, conversationId: string) => void) | undefined;
	return {
		setGuard(next: (db: Database, conversationId: string) => void) {
			guard = next;
		},
		add(conversationId: string, input: AddContinuity): Promise<ContinuityItem> {
			return store.write((db) => {
				if (listItems(db, conversationId, true).length >= MAX_ACTIVE_CONTINUITY)
					throw new Error("invalid_continuity_limit");
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
				guard?.(db, conversationId);
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
