import {
	CONTRACT_VERSIONS,
	verifyForgetJournal,
	type ForgetJournalEntry,
} from "eumenes-memory";
import {
	assertMemorySchema,
	reconcileForgetJournal,
} from "eumenes-memory/sqlite";
import { existsSync } from "node:fs";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	bumpForgetSeq,
	deleteTendenciesByEvidence,
	isBlockApplied,
} from "../repository";
import { purgeUsageFor } from "../repository/usage";
import type { createBackfill } from "./backfill";
import type { createContextWindowStore } from "./context-window";
import type { createForget } from "./forget";
import {
	blockJournalPathOf,
	intentOf,
	intentsOf,
	readJournal,
	readJournalLenient,
	setJournalAside,
	type BlockJournalEntry,
} from "./journal";
import type { createLedger } from "./ledger";
/** A recovery step that must roll the recovery transaction back; `reason` is what `recover` reports. */
class RecoveryStepFailed extends Error {
	constructor(
		readonly reason: string,
		cause: unknown,
	) {
		super(reason, { cause });
	}
}

export function createMemoryRecovery(deps: {
	store: SqliteStore;
	health: { healthy: boolean; wasUnhealthy: boolean };
	journalPath: string;
	journalBlocked: Set<string>;
	atMs: () => number;
	forgetter: ReturnType<typeof createForget>;
	windows: ReturnType<typeof createContextWindowStore>;
	ledger: ReturnType<typeof createLedger>;
	backfill: ReturnType<typeof createBackfill>;
}) {
	const {
		store,
		health,
		journalPath,
		journalBlocked,
		atMs,
		forgetter,
		windows,
		ledger,
		backfill,
	} = deps;
	const blockJournalPath = blockJournalPathOf(journalPath);
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

	/**
	 * The message ids the journals say are forgotten, kept in process for the history to hide (also while memory is
	 * unhealthy). Reads every line that parses: hiding more than the database knows is the safe side, and a damaged
	 * journal must not let a forgotten message come back. The block journal of earlier versions counts until it is
	 * imported.
	 */
	function hideJournaledMessages(): void {
		const entries = readJournalLenient(journalPath);
		const legacy = readJournalLenient<BlockJournalEntry>(blockJournalPath);
		journalBlocked.clear();
		for (const { intent } of intentsOf(
			entries.filter((entry) => typeof entry === "object" && entry !== null),
		))
			for (const id of intent.messageIds) journalBlocked.add(id);
		for (const line of legacy)
			for (const id of Array.isArray(line?.messageIds) ? line.messageIds : [])
				journalBlocked.add(id);
	}

	async function recover(): Promise<{
		healthy: boolean;
		reapplied: number;
		reason?: string;
		/** The database was older than the journal: change-feed subscribers must drop their cursors. */
		feedResyncRequired?: true;
	}> {
		const fail = (reason: string) => {
			health.healthy = false;
			health.wasUnhealthy = true;
			return { healthy: health.healthy, reapplied: 0, reason };
		};
		try {
			return await store.write((db) => {
				// First of all, whatever else fails: the history must hide what the journal says is forgotten.
				hideJournaledMessages();
				try {
					// A newer or tampered schema disables memory instead of being read.
					assertMemorySchema(db);
				} catch {
					return fail("schema_mismatch");
				}
				let entries: ForgetJournalEntry[];
				try {
					entries = readJournal(journalPath);
				} catch {
					return fail("journal_unreadable");
				}
				let legacy: BlockJournalEntry[];
				try {
					legacy = readJournal<BlockJournalEntry>(blockJournalPath);
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
				// Re-applied forgets removed values the published layer may still hold.
				let republish = result.reapplied > 0;
				// Section 6.2 step 4 again for the entries the reconciliation re-applied (a rolled-back commit, a crash,
				// a restored older database): their purge of memory's own data went with the database, so it runs again.
				const reapplied = result.hostIntentsToReapply ?? [];
				for (const { forgetId, hostIntent } of reapplied) {
					const intent = intentOf(hostIntent);
					if (
						forgetter.purgeDerivedInTransaction(db, {
							forgetId: intent.legacyBlockForgetId ?? forgetId,
							conversationId: intent.conversationId,
							itemIds: intent.itemIds,
							messageIds: intent.messageIds,
							derived: intent.derived,
						})
					)
						republish = true;
				}
				let completedIntents = 0;
				let imported = 0;
				try {
					const journaled = new Set(
						entries.flatMap((entry) =>
							entry.targets
								.filter((target) => target.type === "state_item")
								.map((target) => target.id),
						),
					);
					const stillThere = (ids: readonly string[]) =>
						ids.filter(
							(id) => !journaled.has(id) && forgetter.factOf(db, id) !== null,
						);
					// An intent whose items did not all reach an entry (a forget split over several entries that stopped
					// after the first one): the remaining items are forgotten now. Planning needs the database at the
					// journal's head, so this follows the reconciliation.
					for (const { intent } of intentsOf(entries)) {
						const missing = stillThere(intent.itemIds);
						if (missing.length === 0) continue;
						forgetter.forgetItems(db, missing, null, () => {});
						for (const id of missing) journaled.add(id);
						completedIntents += missing.length;
					}
					// The block journal of earlier versions: each line not yet imported becomes one forget journal entry
					// (its intent, and the items it never got to forget), recognized afterwards by its forgetId.
					const done = new Set(
						intentsOf(entries).flatMap(({ intent }) =>
							intent.legacyBlockForgetId ? [intent.legacyBlockForgetId] : [],
						),
					);
					for (const line of legacy) {
						if (done.has(line.forgetId)) {
							// Imported already. Its purge went in the same transaction as the import, so a missing mark
							// means it never ran (an older database, a failure): run it again.
							if (!isBlockApplied(db, line.forgetId)) {
								forgetter.purgeDerivedInTransaction(db, {
									forgetId: line.forgetId,
									conversationId: line.conversationId,
									itemIds: line.itemIds,
									messageIds: line.messageIds,
									derived: line.derived,
								});
								republish = true;
							}
							continue;
						}
						const missing = stillThere(line.itemIds);
						const intent = {
							conversationId: line.conversationId,
							messageIds: line.messageIds,
							itemIds: line.itemIds,
							...(line.derived !== undefined ? { derived: line.derived } : {}),
							legacyBlockForgetId: line.forgetId,
						};
						forgetter.forgetItems(db, missing, intent, () => {});
						for (const id of missing) journaled.add(id);
						done.add(line.forgetId);
						if (!isBlockApplied(db, line.forgetId)) {
							forgetter.purgeDerivedInTransaction(db, {
								forgetId: line.forgetId,
								conversationId: intent.conversationId,
								itemIds: intent.itemIds,
								messageIds: intent.messageIds,
								derived: intent.derived,
							});
							republish = true;
						}
						imported++;
					}
					if (completedIntents > 0 || imported > 0) {
						entries = readJournal(journalPath);
						if (verifyForgetJournal(entries).status !== "ok")
							return fail("journal_chain_broken");
					}
					// Every line is in the forget journal now (durable): the old file is set aside. A rollback of this
					// transaction only leaves the journal ahead of the database, which the next start re-applies.
					if (existsSync(blockJournalPath)) setJournalAside(blockJournalPath);
				} catch (error) {
					// Roll the whole recovery back: nothing it applied half-way may be committed. Lines it already
					// appended stay in the journal ahead of the database, and the next start re-applies them.
					throw new RecoveryStepFailed("block_recovery_failed", error);
				}
				if (completedIntents > 0 || imported > 0) republish = true;
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
				// Units that started before something was (re)applied must not be adopted; a plain restart changes nothing.
				if (
					result.reapplied > 0 ||
					completedIntents > 0 ||
					imported > 0 ||
					reapplied.length > 0
				)
					bumpForgetSeq(db);
				if (republish) {
					windows.recordImmediateInTransaction(db, "state_forget", null);
					windows.purgeInTransaction(db);
				}
				// The imported lines' messages now come from the forget journal.
				if (imported > 0) hideJournaledMessages();
				health.healthy = true;
				// Coming back from an unhealthy spell: what was said meanwhile is not learned.
				if (health.wasUnhealthy) {
					ledger.skipUncuratedEventsInTransaction(db);
					health.wasUnhealthy = false;
				}
				backfill.runInTransaction(db);
				return {
					healthy: health.healthy,
					reapplied: result.reapplied,
					...(result.feedResyncRequired === true
						? { feedResyncRequired: true as const }
						: {}),
				};
			});
		} catch (error) {
			hideJournaledMessages();
			return fail(
				error instanceof RecoveryStepFailed ? error.reason : "recover_failed",
			);
		}
	}

	return { recover: recoverWithRetry };
}
