import type { Database } from "bun:sqlite";
import {
	CONTRACT_VERSIONS,
	sliceUtf8Range,
	verifyForgetJournal,
} from "eumenes-memory";
import type { AccessContext } from "eumenes-memory";
import {
	assertMemorySchema,
	listState,
	reconcileForgetJournal,
} from "eumenes-memory/sqlite";
import type { ForgetJournalEntry, StateItem } from "eumenes-memory/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import type { ConversationService } from "../../conversation";
import type { ContinuityService } from "../../continuity";
import {
	type ForgetInput,
	type ForgetOutcome,
	type ForgetPurge,
	type MemoryEmbed,
	type MemoryItemDto,
	type MemoryStatus,
	PRINCIPAL,
	PROFILE_SCOPE,
	type PreparedWindow,
	type SettleResult,
	type TurnRecall,
} from "../contracts";
import {
	bumpForgetSeq,
	deleteTendenciesByEvidence,
	getUsage,
	insertUsage,
	provenanceOf,
	pruneUsage,
	readSettings,
	writeSettings,
} from "../repository";
import { createAgentVectors } from "./agent-vectors";
import { SHORT_TERM_BYTES, noteLines, renderShortTerm } from "./context-render";
import { verbatimHistory, verbatimMessageIds } from "./context-history";
import {
	createContextWindowStore,
	type WindowSnapshot,
} from "./context-window";
import { createCuration } from "./curation";
import { createForget } from "./forget";
import {
	type BlockJournalEntry,
	blockJournalPathOf,
	readJournal,
} from "./journal";
import { createLedger } from "./ledger";
import { recallTurns, type RecallInput } from "./turn-recall";
import { dropVectorsOnRetract } from "./retract-vectors";
import { createMemoryViews } from "./views";
import { validityOf } from "./validity";
import pkg from "eumenes-memory/package.json";

const PACKAGE_VERSION = pkg.version;
const sha = (text: string) => sha256Hex(text);

/** The words an item stands on, cut out of the messages by their recorded byte ranges. */
function evidenceOf(
	conversation: ConversationService,
	db: Database,
	item: StateItem,
): MemoryItemDto["evidence"] {
	return item.evidence
		.filter((ref) => ref.namespace === "conversation")
		.map((ref) => {
			const found = conversation.messageInTransaction(db, ref.id);
			const slice =
				found && ref.range
					? sliceUtf8Range(found.message.text, ref.range)
					: undefined;
			return {
				messageId: ref.id,
				quote: slice?.status === "ok" ? slice.text : null,
			};
		});
}

function itemDto(
	conversation: ConversationService,
	db: Database,
	item: StateItem,
): MemoryItemDto {
	return {
		id: item.itemId,
		kind: item.kind,
		semanticKey: item.semanticKey,
		text: item.value.text,
		polarity: item.value.polarity,
		status: item.status,
		origin: item.origin,
		revision: item.revision,
		sourceMessageIds: item.evidence
			.filter((ref) => ref.namespace === "conversation")
			.map((ref) => ref.id),
		validFromMs: item.validFromMs,
		validUntilMs: item.validUntilMs,
		evidence: evidenceOf(conversation, db, item),
		validity: validityOf(item),
		capturedBy: provenanceOf(db, item.itemId),
	};
}

export function createMemoryService(
	store: SqliteStore,
	conversation: ConversationService,
	continuity: ContinuityService,
	options: {
		/** The forget journal; the block journal lives next to it (`blockJournalPathOf`). */
		journalPath: string;
		clock?: () => string;
		id?: () => string;
		/** Embedding for the turn vectors; looked up at each use, so the application may create it after memory. */
		embed?: () => MemoryEmbed | undefined;
	},
) {
	const clock = options.clock ?? (() => new Date().toISOString());
	const newId = options.id ?? (() => crypto.randomUUID());
	let healthy = false;
	/** Set by a failed recovery, cleared by the next good one. */
	let wasUnhealthy = false;
	/**
	 * The policy revision access() puts into every AccessContext. Other domains
	 * (World) that must present the SAME revision to Memory read it here, never
	 * from the settings table.
	 */
	const policyRevisionInTransaction = (db: Database): string =>
		String(readSettings(db).revision);
	const access = (db: Database, purpose: string): AccessContext => ({
		principal: PRINCIPAL,
		scopeKeys: [PROFILE_SCOPE],
		purpose,
		policyRevision: policyRevisionInTransaction(db),
	});
	const scoped = (db: Database, purpose: string) => ({
		contractVersion: 1 as const,
		access: access(db, purpose),
		scopeKey: PROFILE_SCOPE,
	});
	const atMs = () => Date.parse(clock());
	const windows = createContextWindowStore({
		continuity,
		clock,
		id: newId,
	});

	const toDto = (db: Database, item: StateItem) =>
		itemDto(conversation, db, item);

	/** The profile's State as the library lists it; a refusal is an error, never an empty profile. */
	function stateItems(
		db: Database,
		includeInactive: boolean,
		purpose = "memory.read",
	): readonly StateItem[] {
		const result = listState(db, {
			...scoped(db, purpose),
			includeInactive,
		});
		if (result.status !== "ok") throw new Error("memory_blocked");
		return result.items;
	}

	function reject(code: string): never {
		throw new Error(code);
	}

	/** Removes receipts that reference any of the given items, in one pass over the (pruned, bounded) table. */
	function purgeUsageFor(db: Database, itemIds: Iterable<string>) {
		const targets = new Set(itemIds);
		if (targets.size === 0) return;
		const rows = db
			.query("SELECT run_id, item_ids FROM memory_usage")
			.all() as Array<{ run_id: string; item_ids: string }>;
		const remove = db.query("DELETE FROM memory_usage WHERE run_id = ?");
		for (const row of rows) {
			const ids = JSON.parse(row.item_ids) as string[];
			if (ids.some((id) => targets.has(id))) remove.run(row.run_id);
		}
	}

	/** A transient failure (busy queue, closing) must not leave memory off until the next restart. */
	async function recoverWithRetry() {
		let result = await recover();
		for (
			let attempt = 0;
			attempt < 3 && result.reason === "recover_failed";
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
			result = await recover();
		}
		return result;
	}

	// Continuity additions are checked against the short-term layer's byte budget in their own transaction.
	continuity.setGuard((db, conversationId) => {
		const { fullBytes } = renderShortTerm(
			[],
			noteLines(continuity.snapshotInTransaction(db, conversationId).items),
		);
		if (fullBytes > SHORT_TERM_BYTES) reject("invalid_continuity_limit");
	});
	// The user closing an item takes effect for runs in flight; additions do not (they reach the short-term layer).
	continuity.setUserChangeHook((db) =>
		windows.recordImmediateInTransaction(db, "continuity_close", null),
	);

	conversation.setRetractHook(dropVectorsOnRetract(conversation));

	const ledger = createLedger({
		store,
		conversation,
		clock,
		active: (db) => healthy && readSettings(db).enabled,
	});
	const curation = createCuration({
		conversation,
		continuity,
		windows,
		clock,
		id: newId,
		atMs,
		ready: () => healthy,
		scoped,
	});
	const purgeHooks: Array<(db: Database, purge: ForgetPurge) => void> = [];
	const blockJournalPath = blockJournalPathOf(options.journalPath);
	const forgetter = createForget({
		journalPath: options.journalPath,
		blockJournalPath,
		access,
		atMs,
		clock,
		id: newId,
		windows,
		conversation,
		continuity,
		ready: () => healthy,
		purgeUsageFor,
		purgeHooks,
	});
	const views = createMemoryViews({
		store,
		continuity,
		windows,
		healthy: () => healthy,
	});
	const vectors = createAgentVectors({
		conversation,
		atMs,
		embed: options.embed,
		recall: (db, input) => recallTurns(db, conversation, input),
	});

	function setEnabledInTransaction(
		db: Database,
		enabled: boolean,
	): MemoryStatus {
		// Toggling to the same value must not invalidate runs in flight.
		if (readSettings(db).enabled !== enabled) {
			writeSettings(db, enabled);
			windows.recordImmediateInTransaction(db, "settings", null);
			// What was said while memory was off is never learned.
			if (enabled) ledger.skipPendingExchangesInTransaction(db);
		}
		return { enabled, healthy };
	}

	async function recover(): Promise<{
		healthy: boolean;
		reapplied: number;
		reason?: string;
		/** The database was older than the journal: change-feed subscribers must drop their cursors. */
		feedResyncRequired?: true;
	}> {
		const fail = (reason: string) => {
			healthy = false;
			wasUnhealthy = true;
			return { healthy, reapplied: 0, reason };
		};
		try {
			return await store.write((db) => {
				try {
					// A newer or tampered schema disables memory instead of being read.
					assertMemorySchema(db);
				} catch {
					return fail("schema_mismatch");
				}
				let entries: ForgetJournalEntry[];
				let blocks: BlockJournalEntry[];
				try {
					entries = readJournal(options.journalPath);
				} catch {
					return fail("journal_unreadable");
				}
				try {
					blocks = readJournal<BlockJournalEntry>(blockJournalPath);
				} catch {
					return fail("block_journal_unreadable");
				}
				if (verifyForgetJournal(entries).status !== "ok")
					return fail("journal_chain_broken");
				const result = reconcileForgetJournal(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					entries,
					clock: { atMs: atMs() },
				});
				if (result.status !== "ok") return fail(result.reasonCode);
				// Section 6.4 step 2, after the reconciliation (planning a forget needs the database at the journal's
				// head): a forget whose intent was written but whose State forget never reached the forget journal is
				// completed here. Items already in the forget journal were re-applied above.
				let completedIntents = 0;
				try {
					const journaled = new Set(
						entries.flatMap((entry) =>
							entry.targets
								.filter((target) => target.type === "state_item")
								.map((target) => target.id),
						),
					);
					for (const line of blocks)
						for (const id of line.itemIds)
							if (!journaled.has(id) && forgetter.factOf(db, id) !== null) {
								forgetter.forgetStateId(db, id, () => {});
								journaled.add(id);
								completedIntents++;
							}
					if (completedIntents > 0) {
						entries = readJournal(options.journalPath);
						if (verifyForgetJournal(entries).status !== "ok")
							return fail("journal_chain_broken");
					}
				} catch {
					return fail("block_recovery_failed");
				}
				// Re-applied forgets removed values the published layer may still hold.
				let republish = result.reapplied > 0 || completedIntents > 0;
				// Receipts of every journaled forget are purged here too: a forget that was only re-applied
				// (rolled-back commit, crash, restored old database) never ran the purge in its own transaction.
				const forgottenIds = entries.flatMap((entry) =>
					entry.targets
						.filter((target) => target.type === "state_item")
						.map((target) => target.id),
				);
				purgeUsageFor(db, forgottenIds);
				// The same holds for tendencies derived from a re-applied forget's items.
				if (deleteTendenciesByEvidence(db, "state", forgottenIds) > 0)
					republish = true;
				// Section 6.2 step 4 again for every intent: blocks, notes, vectors, summaries, steward data.
				for (const line of blocks)
					if (
						forgetter.purgeDerivedInTransaction(db, {
							forgetId: line.forgetId,
							conversationId: line.conversationId,
							itemIds: line.itemIds,
							messageIds: line.messageIds,
						})
					)
						republish = true;
				// Units that started before this reconciliation must not be adopted.
				bumpForgetSeq(db);
				if (republish) {
					windows.recordImmediateInTransaction(db, "state_forget", null);
					windows.purgeInTransaction(db);
				}
				healthy = true;
				// Coming back from an unhealthy spell: what was said meanwhile is not learned.
				if (wasUnhealthy) {
					ledger.skipPendingExchangesInTransaction(db);
					wasUnhealthy = false;
				}
				return {
					healthy,
					reapplied: result.reapplied,
					...(result.feedResyncRequired === true
						? { feedResyncRequired: true as const }
						: {}),
				};
			});
		} catch {
			return fail("recover_failed");
		}
	}

	return {
		policyRevisionInTransaction,
		windows,
		status(): MemoryStatus {
			return { enabled: store.read((db) => readSettings(db).enabled), healthy };
		},
		/** Memory is switched on and its journals are consistent (the steward only works then). */
		readyInTransaction: (db: Database): boolean =>
			healthy && readSettings(db).enabled,
		setEnabled(enabled: boolean): Promise<MemoryStatus> {
			return store.write((db) => setEnabledInTransaction(db, enabled));
		},
		setEnabledInTransaction,
		/**
		 * Must complete before workers start. A broken journal makes memory unusable (fail closed).
		 * The journals are read inside the writer queue, so they can never be older than the database head.
		 */
		recover: recoverWithRetry,
		list(includeInactive = false): MemoryItemDto[] {
			// Fail closed: with an inconsistent journal a forgotten value may still be in this database.
			if (!healthy) return [];
			return store.read((db) => {
				const result = listState(db, {
					...scoped(db, "memory.list"),
					includeInactive,
				});
				return result.status === "ok"
					? result.items.map((item) => toDto(db, item))
					: [];
			});
		},
		/** Active (or, with `includeInactive`, every live-status) State items of the profile, as the library holds them. */
		stateItemsInTransaction: (
			db: Database,
			includeInactive = false,
		): readonly StateItem[] =>
			stateItems(db, includeInactive, "memory.steward"),
		/** A State item as the screen shows it. */
		itemDtoInTransaction: toDto,
		/**
		 * The steward's save (section 3.1), element by element: host-built evidence, normalized keys, replaces,
		 * origin. Each result says applied or rejected with a reason. Throws `memory_unavailable` while memory is not usable.
		 */
		applyCurationInTransaction: curation.applyCurationInTransaction,
		/**
		 * Section 6: block journal -> forget_seq -> State forget -> derived data, in the writer transaction. Works even
		 * when memory is off. When the transaction fails after the journal was written, memory closes, reconciles
		 * (which completes the forget from the journal) and the call rejects with `memory_forget_incomplete`.
		 */
		forget(input: ForgetInput): Promise<ForgetOutcome> {
			let journaled = false;
			return store
				.write((db) =>
					forgetter.forgetInTransaction(db, input, () => {
						journaled = true;
					}),
				)
				.catch(async (error: unknown) => {
					// Only when an entry may have reached a journal ahead of the rolled-back database: reconcile
					// before anything else runs. Rejections before the journal (validation, queue full) change nothing.
					if (journaled) {
						healthy = false;
						await recoverWithRetry();
						// The journal carries the forget to completion; the caller must not assume it finished.
						throw new Error("memory_forget_incomplete");
					}
					throw error;
				});
		},
		/**
		 * The same forget inside a writer transaction the caller owns. The journals are reconciled once that
		 * transaction is over (it may roll back after the entry was written); a failure closes memory first.
		 */
		forgetInTransaction(db: Database, input: ForgetInput): ForgetOutcome {
			let journaled = false;
			try {
				const forgotten = forgetter.forgetInTransaction(db, input, () => {
					journaled = true;
				});
				void recoverWithRetry();
				return forgotten;
			} catch (error) {
				if (!journaled) throw error;
				healthy = false;
				void recoverWithRetry();
				throw new Error("memory_forget_incomplete");
			}
		},
		/**
		 * Registers a purge that runs inside every forget's transaction, and again for every block journal line at
		 * startup (so it must be idempotent). The steward deletes its decisions and inbox bodies here.
		 */
		registerForgetPurge(hook: (db: Database, purge: ForgetPurge) => void) {
			purgeHooks.push(hook);
		},
		/** Embedding of the turns and the prefetch query, and the turn-vector store (the steward uses them). */
		vectors,
		...ledger,
		...views,
		/**
		 * Prepare-time read of the run's ContextWindow (write transaction). null when memory is off or unhealthy:
		 * the run then proceeds without memory. A library refusal throws `memory_blocked` instead of being hidden.
		 */
		windowForRunInTransaction(
			db: Database,
			conversationId: string,
		): WindowSnapshot | null {
			if (!healthy || !readSettings(db).enabled) return null;
			const window = windows.readForRunInTransaction(db, conversationId);
			// Prefetched exchanges whose messages changed since are dropped now: they would expire every run until replaced.
			if (
				window.prefetch.pins.some((pin) => {
					const found = conversation.messageInTransaction(db, pin.messageId);
					return !found || sha(found.message.text) !== pin.digest;
				})
			)
				return windows.rebuildInTransaction(db, conversationId, {
					refreshLongTerm: false,
					prefetch: { text: "", pins: [], bytes: 0 },
				});
			return window;
		},
		/**
		 * Earlier exchanges that resemble `vector`, from before the verbatim window (read-only, no tool call).
		 * null when memory is off or unhealthy, or nothing qualifies.
		 */
		recallTurnsInRead(db: Database, input: RecallInput): TurnRecall | null {
			if (!healthy || !readSettings(db).enabled) return null;
			return recallTurns(db, conversation, input);
		},
		/**
		 * Adoption-time check in the writer transaction. Additions never expire a run; immediate changes by
		 * anyone but the run's own memory step, a settings change, or a changed pinned message do.
		 */
		validateWindowInTransaction(
			db: Database,
			runId: string,
			window: PreparedWindow,
			extraPins: ReadonlyArray<{ messageId: string; digest: string }> = [],
		): SettleResult {
			if (!healthy || !readSettings(db).enabled)
				return { ok: false, reason: "memory_unavailable" };
			if (String(readSettings(db).revision) !== window.policyRevision)
				return { ok: false, reason: "memory_stale" };
			if (windows.changedSinceInTransaction(db, window.immediateSeq, runId))
				return { ok: false, reason: "memory_stale" };
			for (const pin of [...window.pins, ...extraPins]) {
				const found = conversation.messageInTransaction(db, pin.messageId);
				if (!found || sha(found.message.text) !== pin.digest)
					return { ok: false, reason: "memory_stale" };
			}
			return { ok: true };
		},
		/**
		 * The steward's republish of the window (section 2.4): history, summary, short-term layer and notices from the
		 * ledger and State; L1 only when asked or when an immediate change, a policy change or a validity boundary
		 * requires it. Records no immediate change, so a run in flight is not expired.
		 */
		publishWindowInTransaction: windows.publishInTransaction,
		/** The verbatim history of a prompt: L3 in the window's order and what is still unprocessed (section 2.3). */
		verbatimHistoryInTransaction: (
			db: Database,
			conversationId: string,
			window: WindowSnapshot,
		) => verbatimHistory(db, conversationId, window.history),
		/** What a run keeps of a window for the adoption check (the texts stay in its prompt). */
		preparedWindow(
			window: WindowSnapshot,
			shownMessageIds: readonly string[] = [],
		): PreparedWindow {
			return {
				conversationId: window.conversationId,
				version: window.version,
				buildId: window.buildId,
				immediateSeq: window.inputs.immediateSeq,
				policyRevision: window.inputs.policyRevision,
				manifest: [
					...window.longTerm.manifest.map((entry) => entry.itemId),
					...(window.shortTerm.recentItemIds ?? []),
				],
				pins: window.prefetch.pins,
				prefetchBytes: window.prefetch.bytes,
				noticeIds: window.notices.map((notice) => notice.id),
				shownMessageIds: [...shownMessageIds],
			};
		},
		/** The usage receipt of an adopted run: which window version it read. */
		recordUsageInTransaction(
			db: Database,
			runId: string,
			conversationId: string,
			window: PreparedWindow,
		) {
			insertUsage(db, {
				runId,
				conversationId,
				viewDigest: `window:${window.version}:${window.buildId}`,
				stateRevision: String(window.immediateSeq),
				packageVersion: PACKAGE_VERSION,
				viewSchema: 3,
				itemIds: window.manifest,
				createdAt: clock(),
			});
			pruneUsage(db);
		},
		/** Notices are shown once: dropped when the answer that carried them is stored. */
		clearNoticesInTransaction(
			db: Database,
			conversationId: string,
			noticeIds: readonly string[],
		) {
			if (noticeIds.length === 0) return;
			windows.clearNoticesInTransaction(db, conversationId, noticeIds);
		},
		/** The adoption failed after the receipt was written: no answer exists, so no receipt may either. */
		discardUsageInTransaction(db: Database, runId: string) {
			db.query("DELETE FROM memory_usage WHERE run_id = ?").run(runId);
		},
		usage(runId: string) {
			return store.read((db) => getUsage(db, runId));
		},
	};
}
export type MemoryService = ReturnType<typeof createMemoryService>;
