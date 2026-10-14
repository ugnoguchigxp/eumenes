import type { Database } from "bun:sqlite";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import type { AccessContext } from "eumenes-memory";
import {
	applyForget,
	listState,
	planForget,
	readStateFact,
} from "eumenes-memory/sqlite";
import type { ConversationService } from "../../conversation";
import type { ContinuityService } from "../../continuity";
import {
	FORGET_MAX_ITEMS,
	PROFILE_SCOPE,
	type ForgetInput,
	type ForgetOutcome,
	type ForgetPurge,
} from "../contracts";
import {
	blockedAmong,
	bumpForgetSeq,
	conversationsSummarizing,
	deleteProvenance,
	deleteSummary,
	deleteTendenciesByEvidence,
	deleteTurnVectors,
	dropExchangesOfMessages,
	insertBlocks,
	markBlockApplied,
	mergeNeighbours,
	readSummary,
	resetSummarized,
} from "../repository";
import type { ContextWindowStore } from "./context-window";
import { appendJournal, type BlockJournalEntry } from "./journal";

const VERSION = 1 as const;
export const STATE_ID = /^state:[0-9a-f]{64}$/;

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
/** The input message ids of the exchanges these messages belong to (the ids a summary's sources are keyed by). */
function inputsOf(db: Database, messageIds: readonly string[]): string[] {
	const inputs = new Set(messageIds);
	const find = db.query(
		"SELECT input_message_id AS i FROM memory_exchange WHERE answer_message_id = ?",
	);
	for (const id of messageIds) {
		const row = find.get(id) as { i: string } | null;
		if (row) inputs.add(row.i);
	}
	return [...inputs];
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

	/** State items outside `known` whose evidence messages are all among `messageIds` (nothing else keeps them standing). */
	function itemsResting(
		db: Database,
		messageIds: ReadonlySet<string>,
		known: ReadonlySet<string>,
	): string[] {
		const listed = listState(db, {
			contractVersion: VERSION,
			access: access(db, "memory.forget"),
			scopeKey: PROFILE_SCOPE,
			includeInactive: true,
		});
		if (listed.status !== "ok") return refuse("memory_blocked");
		return listed.items
			.filter((item) => {
				if (known.has(item.itemId)) return false;
				const sources = item.evidence.filter(
					(ref) => ref.namespace === "conversation",
				);
				return (
					sources.length > 0 && sources.every((ref) => messageIds.has(ref.id))
				);
			})
			.map((item) => item.itemId);
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
		const listed = listState(db, {
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

	/** The exchange partners (B3): everything the run of each message produced, and the ledger's answer/input. */
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
			const row = db
				.query(
					"SELECT input_message_id AS i, answer_message_id AS a FROM memory_exchange WHERE input_message_id = ?1 OR answer_message_id = ?1",
				)
				.get(id) as { i: string; a: string | null } | null;
			if (row) {
				all.add(row.i);
				if (row.a) all.add(row.a);
			}
		}
		return [...all];
	}

	/**
	 * Section 6.2, step 4: everything derived from the forgotten items and messages. Idempotent, so a restart can
	 * run it again for a journal line. Returns whether it changed anything the next prompt could show.
	 */
	function purgeDerivedInTransaction(
		db: Database,
		purge: Omit<ForgetPurge, "deletedSummaryConversationIds"> & {
			forgetId: string;
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
		// Summaries that stand on them go, with their sources; the other exchanges they covered are summarized again.
		const inputIds = inputsOf(db, existing);
		const deletedSummaryConversationIds = conversationsSummarizing(
			db,
			inputIds,
		);
		for (const conversationId of deletedSummaryConversationIds) {
			const summary = readSummary(db, conversationId);
			deleteSummary(db, conversationId);
			if (summary) {
				const gone = new Set(inputIds);
				resetSummarized(
					db,
					summary.sources.filter((id) => !gone.has(id)),
					now,
				);
			}
			changed = true;
		}
		dropExchangesOfMessages(db, existing, now);
		deps.purgeUsageFor(db, purge.itemIds);
		for (const hook of deps.purgeHooks)
			hook(db, {
				itemIds: purge.itemIds,
				messageIds: existing,
				conversationId: purge.conversationId,
				deletedSummaryConversationIds,
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
			if (
				input.conversationId === "" ||
				(input.itemIds.length === 0 && input.messageIds.length === 0)
			)
				return refuse("invalid_forget");
			if (input.itemIds.length > FORGET_MAX_ITEMS)
				return refuse("forget_limit");
			const itemIds = new Set<string>();
			for (const requested of input.itemIds)
				if (!STATE_ID.test(requested)) return refuse("invalid_memory_item");
			expandItems(db, input.itemIds, itemIds, true);
			// Items and messages pull each other in until nothing more qualifies: the evidence of the items (B1) and the
			// exchange partners (B3) are blocked, and an item whose evidence is all blocked has nothing left to stand on.
			let messageIds: string[];
			for (;;) {
				messageIds = withPartners(db, [
					...evidenceMessages(db, itemIds),
					...input.messageIds,
				]);
				const resting = itemsResting(db, new Set(messageIds), itemIds);
				if (resting.length === 0) break;
				const before = itemIds.size;
				expandItems(db, resting, itemIds, false);
				if (itemIds.size === before) break;
			}
			const forgetId = deps.id();
			const entry: BlockJournalEntry = {
				forgetId,
				conversationId: input.conversationId,
				messageIds,
				itemIds: [...itemIds],
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
