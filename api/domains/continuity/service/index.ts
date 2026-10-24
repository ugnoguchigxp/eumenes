import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { createEventStore } from "./events";
import {
	CONTINUITY_TTL_MS,
	MAX_ACTIVE_CONTINUITY,
	type ContinuityKind,
} from "../contracts";
import type { ContinuityItem, ContinuitySnapshot } from "../contracts";
import {
	addSources,
	conversationRevision,
	getItem,
	insertItem,
	listItems,
	deleteBySource,
	transitionItem,
	updateItem,
} from "../repository";

/** What the memory agent writes: the messages it read it from, and optionally a shorter life than the kind's default. */
export interface AgentContinuityInput {
	kind: ContinuityKind;
	text: string;
	sourceMessageIds: readonly string[];
	expiresAt?: string;
}

export function createContinuityService(
	store: SqliteStore,
	clock: () => string = () => new Date().toISOString(),
	id: () => string = () => crypto.randomUUID(),
) {
	/** Runs inside the write transaction after an item is added or rewritten; throwing rolls it back. */
	let guard: ((db: Database, conversationId: string) => void) | undefined;
	/** When an item of this kind written `now` stops mattering (null: never). */
	const expiryFor = (kind: ContinuityKind, now: string): string | null => {
		const ttl = CONTINUITY_TTL_MS[kind];
		return ttl === undefined
			? null
			: new Date(Date.parse(now) + ttl).toISOString();
	};
	const live = (item: ContinuityItem, nowMs: number) =>
		item.status === "active" &&
		(item.expiresAt === null || Date.parse(item.expiresAt) > nowMs);
	/** Active items inside their life: what counts toward the limit and what the context shows. */
	const liveItems = (
		db: Database,
		conversationId: string,
	): ContinuityItem[] => {
		const nowMs = Date.parse(clock());
		return listItems(db, conversationId, true).filter((item) =>
			live(item, nowMs),
		);
	};
	const assertRoom = (db: Database, conversationId: string) => {
		if (liveItems(db, conversationId).length >= MAX_ACTIVE_CONTINUITY)
			throw new Error("invalid_continuity_limit");
	};
	const snapshotInTransaction = (
		db: Database,
		conversationId: string,
	): ContinuitySnapshot => ({
		revision: conversationRevision(db, conversationId),
		items: liveItems(db, conversationId),
	});
	return {
		setGuard(next: (db: Database, conversationId: string) => void) {
			guard = next;
		},
		/**
		 * An addition by the steward: bounded by the item count and the short-term byte budget, checked
		 * in the caller's transaction. Throws `invalid_continuity_limit`; the caller counts that as a refusal.
		 */
		addByAgentInTransaction(
			db: Database,
			conversationId: string,
			input: AgentContinuityInput,
		): ContinuityItem {
			assertRoom(db, conversationId);
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
				origin: "agent",
				sourceMessageIds: [...new Set(input.sourceMessageIds)],
				expiresAt: input.expiresAt ?? expiryFor(input.kind, now),
			};
			insertItem(db, item);
			guard?.(db, conversationId);
			return item;
		},
		/**
		 * Rewrites an active item. Without an explicit expiry the kind's life starts again: a summary
		 * written today must not vanish on the day the first note would have.
		 * null when the item is gone, closed, or at another revision.
		 */
		updateByAgentInTransaction(
			db: Database,
			itemId: string,
			expectedRevision: number,
			change: {
				text?: string;
				expiresAt?: string;
				/** Messages added to the item's sources (the union; none are removed). */
				addSourceMessageIds?: readonly string[];
			},
		): ContinuityItem | null {
			const existing = getItem(db, itemId);
			if (!existing) return null;
			const now = clock();
			const expiresAt = change.expiresAt ?? expiryFor(existing.kind, now);
			if (
				!updateItem(
					db,
					itemId,
					expectedRevision,
					{
						...(change.text === undefined ? {} : { text: change.text }),
						expiresAt,
					},
					now,
				)
			)
				return null;
			if (change.addSourceMessageIds)
				addSources(db, itemId, change.addSourceMessageIds);
			guard?.(db, existing.conversationId);
			return getItem(db, itemId);
		},
		/** The agent closing an item is not a user change: runs in flight are not expired by it. */
		closeByAgentInTransaction(
			db: Database,
			itemId: string,
			expectedRevision: number,
			status: "resolved" | "retracted",
		): boolean {
			return transitionItem(db, itemId, expectedRevision, status, clock());
		},
		/**
		 * Forgetting messages: physically deletes every note that came from one of them. `noteIds` lists the deleted
		 * notes (the caller deletes what was derived from them); no hook runs, the forget records its own immediate
		 * change. Running it again finds nothing.
		 */
		deleteBySourceMessagesInTransaction(
			db: Database,
			messageIds: readonly string[],
		): { noteIds: string[]; deleted: number } {
			return deleteBySource(db, messageIds);
		},
		list(conversationId: string, includeClosed = false): ContinuityItem[] {
			return store.read((db) => listItems(db, conversationId, !includeClosed));
		},
		/** The conversation's revision alone: cheaper than a snapshot when only a change counter is needed. */
		revisionInTransaction(db: Database, conversationId: string): number {
			return conversationRevision(db, conversationId);
		},
		/** Same-transaction read so an adoption check sees what the writer will commit. Expired items are left out. */
		snapshotInTransaction,
		/** A snapshot outside a writer transaction (read-only API). */
		snapshot(conversationId: string): ContinuitySnapshot {
			return store.read((db) => snapshotInTransaction(db, conversationId));
		},
		/** The event flow, episode, work results and window version (the active short-term memory). */
		events: createEventStore(),
	};
}
export type ContinuityService = ReturnType<typeof createContinuityService>;
