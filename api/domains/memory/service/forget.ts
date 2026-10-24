import { listAllState } from "./state-snapshot";
import type { Database } from "bun:sqlite";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import type { AccessContext } from "eumenes-memory";
import { applyForget, planForget, readStateFact } from "eumenes-memory/sqlite";
import type { ConversationService } from "../../conversation";
import type { ContinuityService } from "../../continuity";
import {
	FORGET_MAX_ITEMS,
	PROFILE_SCOPE,
	type ForgetDerived,
	type ForgetInput,
	type ForgetOutcome,
	type ForgetPurge,
} from "../contracts";
import {
	blockedAmong,
	bumpForgetSeq,
	deleteProvenance,
	deleteTendenciesByEvidence,
	deleteTurnVectors,
	insertBlocks,
	markBlockApplied,
	mergeNeighbours,
	seedFenceForItems,
	SEED_IMPORT_FENCE,
} from "../repository";
import type { ContextWindowStore } from "./context-window";
import { appendJournal, type BlockJournalEntry } from "./journal";

const VERSION = 1 as const;
const STATE_ID = /^state:[0-9a-f]{64}$/;

/** What forgetting needs from the memory service around it. */
export type ForgetDeps = {
	journalPath: string;
	blockJournalPath: string;
	/** The message ids of the block journal, held in process (memory adds to it as soon as a line is written). */
	journalBlocked: Set<string>;
	access: (db: Database, purpose: string) => AccessContext;
	atMs: () => number;
	clock: () => string;
	id: () => string;
	windows: ContextWindowStore;
	conversation: ConversationService;
	continuity: ContinuityService;
	/** Memory is usable (its journals are consistent). */
	ready: () => boolean;
	/** Removes the usage receipts that name any of the items. */
	purgeUsageFor: (db: Database, itemIds: Iterable<string>) => void;
	/** The derived-data purges other domains registered (the steward's decisions and inbox). */
	purgeHooks: ReadonlyArray<(db: Database, purge: ForgetPurge) => void>;
};

/** A record of string lists; memory checks the shape only, never the meaning. */
function isDerived(value: unknown): value is ForgetDerived {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	return Object.entries(value).every(
		([key, ids]) =>
			key !== "" &&
			Array.isArray(ids) &&
			ids.every((id) => typeof id === "string" && id !== ""),
	);
}

function refuse(code: string): never {
	throw new Error(code);
}

function deleteTurnVectorsOf(db: Database, messageIds: string[]): number {
	const present = messageIds.filter(
		(id) =>
			db
				.query("SELECT 1 FROM memory_turn_vector WHERE message_id = ?")
				.get(id) != null,
	);
	deleteTurnVectors(db, present);
	return present.length;
}
export function createForget(deps: ForgetDeps) {
	const { access, atMs, windows, conversation, continuity } = deps;

	/** Every non-forgotten version of the fact the item belongs to (oldest first); null when the item is unknown. */
	function factOf(db: Database, itemId: string): readonly string[] | null {
		const fact = readStateFact(db, {
			contractVersion: VERSION,
			access: access(db, "memory.forget"),
			scopeKey: PROFILE_SCOPE,
			itemId,
		});
		return fact.status === "ok" ? fact.itemIds : null;
	}

	/**
	 * Adds the items and everything that must go with them to `into`: every version of each fact, and (transitively)
	 * the items they were merged from or into. A requested item that is unknown is refused; one found through the
	 * lineage that is already gone is skipped.
	 */
	function expandItems(
		db: Database,
		ids: Iterable<string>,
		into: Set<string>,
		requested: boolean,
	) {
		const stack = [...ids].map((id) => ({ id, requested }));
		const explored = new Set<string>();
		while (stack.length > 0) {
			const next = stack.pop() as { id: string; requested: boolean };
			const fact = factOf(db, next.id);
			if (!fact) {
				if (next.requested) refuse("invalid_memory_item");
				continue;
			}
			for (const member of fact) {
				into.add(member);
				if (explored.has(member)) continue;
				explored.add(member);
				for (const neighbour of mergeNeighbours(db, member))
					stack.push({ id: neighbour, requested: false });
			}
		}
	}

	/** Plan -> forget journal (fsync) -> apply for one State item. */
	function forgetStateId(
		db: Database,
		id: string,
		onJournaled: () => void,
	): { forgetId: string; completed: boolean } {
		const planned = planForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access: access(db, "memory.forget"),
			target: { type: "state_item", itemId: id, scopeKey: PROFILE_SCOPE },
			clock: { atMs: atMs() },
		});
		if (planned.status !== "planned") return refuse("invalid_memory_item");
		onJournaled();
		appendJournal(deps.journalPath, planned.plan.entry);
		const applied = applyForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			entry: planned.plan.entry,
			clock: { atMs: atMs() },
		});
		deps.purgeUsageFor(db, [id]);
		windows.recordImmediateInTransaction(db, "state_forget", null);
		// The rendered windows still hold the forgotten text.
		windows.purgeInTransaction(db);
		return {
			forgetId: planned.plan.entry.forgetId,
			completed: applied.completed,
		};
	}

	/** The messages the versions of these items stand on (B1), read before the forget removes their provenance. */
	function evidenceMessages(
		db: Database,
		itemIds: ReadonlySet<string>,
	): string[] {
		const listed = listAllState(db, {
			contractVersion: VERSION,
			access: access(db, "memory.forget"),
			scopeKey: PROFILE_SCOPE,
			includeInactive: true,
		});
		if (listed.status !== "ok") return refuse("memory_blocked");
		return listed.items
			.filter((item) => itemIds.has(item.itemId))
			.flatMap((item) =>
				item.evidence
					.filter((ref) => ref.namespace === "conversation")
					.map((ref) => ref.id),
			);
	}

	/** The run partners (B3): everything the run of each message produced. */
	function withPartners(db: Database, messageIds: Iterable<string>): string[] {
		const all = new Set<string>();
		for (const id of messageIds) {
			const found = conversation.messageInTransaction(db, id);
			if (!found) continue;
			all.add(id);
			if (found.message.runId)
				for (const entry of conversation.messagesOfRunInTransaction(
					db,
					found.message.conversationId,
					found.message.runId,
				))
					all.add(entry.message.id);
		}
		return [...all];
	}

	/**
	 * Section 6.2, step 4: everything derived from the forgotten items and messages. Idempotent, so a restart can
	 * run it again for a journal line. Returns whether it changed anything the next prompt could show.
	 */
	function purgeDerivedInTransaction(
		db: Database,
		purge: Omit<ForgetPurge, "derived"> & {
			forgetId: string;
			derived?: ForgetDerived;
		},
	): boolean {
		const now = deps.clock();
		let changed = false;
		// Blocked messages: only messages that exist (a restored older database may lack the newest ones).
		const existing = purge.messageIds.filter((id) =>
			conversation.messageInTransaction(db, id),
		);
		const already = blockedAmong(db, existing);
		const fresh = existing.filter((id) => !already.has(id));
		if (fresh.length > 0) changed = true;
		insertBlocks(
			db,
			existing.map((id) => ({
				messageId: id,
				conversationId:
					conversation.messageInTransaction(db, id)?.message.conversationId ??
					purge.conversationId,
				reason: "forgotten" as const,
				forgetId: purge.forgetId,
			})),
			now,
		);
		// Short-term notes that came from them are deleted; tendencies built on notes or items are deleted.
		const notes = continuity.deleteBySourceMessagesInTransaction(
			db,
			purge.messageIds,
		);
		if (notes.deleted > 0) changed = true;
		const tendencies =
			deleteTendenciesByEvidence(db, "continuity", notes.noteIds) +
			deleteTendenciesByEvidence(db, "state", purge.itemIds);
		if (tendencies > 0) changed = true;
		deleteProvenance(db, purge.itemIds);
		if (deleteTurnVectorsOf(db, existing) > 0) changed = true;
		// The active short-term memory (section 13): every event that showed one of them keeps only that it
		// existed, and every episode summary that stood on one becomes an unsummarized range. This is the forget
		// only: blocking a specialist session's messages never comes here.
		if (
			continuity.events.forgetMessagesInTransaction(db, purge.messageIds, now)
				.length > 0
		)
			changed = true;
		deps.purgeUsageFor(db, purge.itemIds);
		for (const hook of deps.purgeHooks)
			hook(db, {
				itemIds: purge.itemIds,
				messageIds: existing,
				conversationId: purge.conversationId,
				derived: purge.derived ?? {},
			});
		// This line's purge is in the database now; a restored older database lacks the mark and runs it again.
		markBlockApplied(db, purge.forgetId, now);
		return changed;
	}
	return {
		factOf,
		forgetStateId,
		purgeDerivedInTransaction,
		/**
		 * Section 6.2: block journal (the intent) -> forget_seq -> State forget (plan -> forget journal -> apply) ->
		 * derived data. `onJournaled` is told before the first line is written: from then on a failure may leave
		 * a journal ahead of the database, which the next recovery completes.
		 */
		forgetInTransaction(
			db: Database,
			input: ForgetInput,
			onJournaled: () => void,
		): ForgetOutcome {
			if (!deps.ready()) return refuse("memory_unavailable");
			let derived = input.derived;
			if (derived !== undefined && !isDerived(derived))
				return refuse("invalid_forget");
			if (
				input.conversationId === "" ||
				(input.itemIds.length === 0 &&
					input.messageIds.length === 0 &&
					!Object.values(derived ?? {}).some((ids) => ids.length > 0))
			)
				return refuse("invalid_forget");
			if (input.itemIds.length > FORGET_MAX_ITEMS)
				return refuse("forget_limit");
			const itemIds = new Set<string>();
			for (const requested of input.itemIds)
				if (!STATE_ID.test(requested)) return refuse("invalid_memory_item");
			expandItems(db, input.itemIds, itemIds, true);
			const seedDigest = seedFenceForItems(db, itemIds);
			if (seedDigest)
				derived = { ...derived, [SEED_IMPORT_FENCE]: [seedDigest] };
			// The evidence of the items (B1) and the exchange partners (B3) are blocked. Other items that rest on the
			// same messages stay: they are facts the user did not ask to forget (the message only leaves the context).
			const messageIds = withPartners(db, [
				...evidenceMessages(db, itemIds),
				...input.messageIds,
			]);
			const forgetId = deps.id();
			const entry: BlockJournalEntry = {
				forgetId,
				conversationId: input.conversationId,
				messageIds,
				itemIds: [...itemIds],
				...(derived !== undefined ? { derived } : {}),
				at: deps.clock(),
			};
			onJournaled();
			appendJournal<BlockJournalEntry>(deps.blockJournalPath, entry);
			for (const id of messageIds) deps.journalBlocked.add(id);
			bumpForgetSeq(db);
			windows.recordImmediateInTransaction(db, "state_forget", null);
			let completed = true;
			for (const id of itemIds)
				completed = forgetStateId(db, id, onJournaled).completed && completed;
			purgeDerivedInTransaction(db, {
				forgetId,
				conversationId: input.conversationId,
				itemIds: entry.itemIds,
				messageIds,
				derived,
			});
			windows.purgeInTransaction(db);
			return {
				forgetId,
				blockedMessageIds: messageIds,
				forgottenItemIds: entry.itemIds,
				completed,
			};
		},
	};
}
