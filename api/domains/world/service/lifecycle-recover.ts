import type { Database } from "bun:sqlite";
import { type ScopeRef } from "eumenes-world-model";
import {
	allIntakeIds,
	dropFeedCursors,
	getIntake,
	intakesWithJournal,
	listKnownScopes,
	listMemoryLinkedIntakes,
	listOpenIntakes,
	readRestore,
	reopenIntakeForMemory,
	upsertConfirmation,
	writeRestore,
} from "../repository/lifecycle";
import { listAbandonedForgetIds } from "../repository/guard";
import { purgeUnsettledExtractEvents } from "../repository/extraction";
import {
	WorldJournalCorruptError,
	readWorldJournal,
	type WorldJournalEntry,
} from "./world-journal";
import type { RecoverReport } from "./lifecycle-types";
import { StepBlocked, transientReason, scopeOf } from "./lifecycle-shared";
import type { LifecycleCtx } from "./lifecycle-lock";
import type { ForgetOps } from "./lifecycle-forget";
import type { RestoreOps } from "./lifecycle-restore";

export function createRecoverOps(
	ctx: LifecycleCtx,
	forget: ForgetOps,
	restore: RestoreOps,
) {
	const { options, store, world, now, memory, withLock, accessFor } = ctx;
	const { resumeForgets, syncConfirmations } = forget;
	const { restoreScope, adoptJournalEntries } = restore;

	/**
	 * After a restore every completed Memory-linked forget is checked again
	 * against Memory's own receipt. A forget stays `complete` only when that
	 * check succeeded and shows every external confirmed (after confirming what
	 * is verifiably gone from World). Anything else - Memory still showing
	 * pending externals the roots do not reach, or a check that hit a transient
	 * error - moves the intake back to `world_applied` (World content stays
	 * deleted), so resume re-confirms it and recoverWorld reports it. Returns
	 * those forgets: the caller keeps the gate CLOSED for them (fail closed).
	 */
	async function reverifyMemory(): Promise<
		{ forgetId: string; reason: string }[]
	> {
		const linked = store.read((db) => listMemoryLinkedIntakes(db));
		const unresolved: { forgetId: string; reason: string }[] = [];
		for (const row of linked) {
			if (row.state !== "complete") continue;
			await withLock(row.forgetId, async () => {
				const regress = async (reason: string) => {
					try {
						await store.write((db) =>
							reopenIntakeForMemory(db, row.forgetId, reason, now()),
						);
					} catch {
						/* the in-memory report below still keeps the gate closed */
					}
					unresolved.push({ forgetId: row.forgetId, reason });
				};
				try {
					const outcome = await store.write((db) => {
						const current = getIntake(db, row.forgetId);
						if (!current || current.memoryForgetId === null) return null;
						const synced = syncConfirmations(db, current);
						const access = accessFor(db, scopeOf(current));
						for (const externalId of synced.confirmable) {
							const result = memory.record(db, access, now(), {
								forgetId: current.memoryForgetId,
								externalId,
								state: "confirmed",
							});
							if (result !== "recorded")
								throw new StepBlocked(`MEMORY_${result.toUpperCase()}`);
							upsertConfirmation(
								db,
								current.memoryForgetId,
								externalId,
								"confirmed",
								now(),
							);
						}
						if (synced.uncovered.length > 0) {
							reopenIntakeForMemory(
								db,
								current.forgetId,
								"MEMORY_EXTERNAL_NOT_COVERED",
								now(),
							);
							return "MEMORY_EXTERNAL_NOT_COVERED";
						}
						return null;
					});
					if (outcome !== null)
						unresolved.push({ forgetId: row.forgetId, reason: outcome });
				} catch (error) {
					const reason = transientReason(error);
					if (reason === null) throw error;
					await regress(reason);
				}
			});
		}
		return unresolved;
	}

	type Decision =
		| { kind: "closed"; reason: string }
		| {
				kind: "ok";
				restore: boolean;
				epoch: string | null;
				scopes: ScopeRef[];
		  };

	function decide(
		entries: readonly WorldJournalEntry[],
		db: Database,
		request: { restore: boolean; reason: string | null },
	): Decision {
		// The database may only reference journal entries that exist, unchanged.
		for (const row of intakesWithJournal(db)) {
			const entry = entries[row.journalSeq! - 1];
			if (!entry) return { kind: "closed", reason: "JOURNAL_TRUNCATED" };
			if (entry.hash !== row.journalHash || entry.forgetId !== row.forgetId)
				return { kind: "closed", reason: "JOURNAL_MISMATCH" };
		}
		const known = allIntakeIds(db);
		const missing = entries.filter((e) => !known.has(e.forgetId));
		const running = readRestore(db);
		const restore =
			request.restore || missing.length > 0 || running?.state === "in_progress";
		const scopes = new Map<string, ScopeRef>();
		for (const scope of [
			...listKnownScopes(db).map((s) => ({
				principal: s.principal,
				scopeKey: s.scopeKey,
			})),
			...(options.scopes ?? []),
			...entries.map((e) => ({ principal: e.principal, scopeKey: e.scopeKey })),
		])
			scopes.set(JSON.stringify([scope.principal, scope.scopeKey]), scope);
		return {
			kind: "ok",
			restore,
			epoch: running?.state === "in_progress" ? running.restoreEpoch : null,
			scopes: [...scopes.values()],
		};
	}

	// recoverWorld() calls are serialised: a second call waits for the first, and
	// only the LAST one outstanding may open the gate, so a call that finishes
	// early can never reopen it in the middle of another call's restore.
	let recoveries = 0;
	let recoverTail: Promise<unknown> = Promise.resolve();

	/**
	 * Startup gate. Call before the queue starts. It verifies the World journal
	 * against the database, detects a restored (older) database, runs the whole
	 * restore when needed, resumes every forget that has not yet deleted its
	 * World content, and only then opens the host gate. Any failure leaves the
	 * gate closed (fail closed) and says why.
	 */
	async function runRecover(
		request: {
			/** A database restore is known (operator action). */
			restored?: boolean;
			/** Memory's recover() reported feedResyncRequired. */
			memoryFeedResyncRequired?: boolean;
		} = {},
	): Promise<RecoverReport> {
		const closed = (reason: string): RecoverReport => {
			options.gate?.close(reason);
			return { status: "closed", reason };
		};
		try {
			let entries: WorldJournalEntry[];
			try {
				entries = readWorldJournal(options.journalPath);
			} catch (error) {
				if (error instanceof WorldJournalCorruptError)
					return closed(`JOURNAL_${error.code.toUpperCase()}`);
				throw error;
			}
			const requested =
				request.restored === true || request.memoryFeedResyncRequired === true;
			const decision = await store.write((db) =>
				decide(entries, db, {
					restore: requested,
					reason: request.restored
						? "OPERATOR_RESTORE"
						: request.memoryFeedResyncRequired
							? "MEMORY_FEED_RESYNC"
							: null,
				}),
			);
			if (decision.kind === "closed") return closed(decision.reason);
			let restored = false;
			if (decision.restore) {
				restored = true;
				// A new epoch only when no restore is already running (resume otherwise).
				const epoch =
					decision.epoch ??
					(await store.write((db) => {
						const token = world.bumpRestoreEpochInWriter(db);
						dropFeedCursors(db);
						// World deletes the unsettled inbox events at restore.begin.
						purgeUnsettledExtractEvents(db);
						writeRestore(
							db,
							token,
							"in_progress",
							request.restored ? "OPERATOR_RESTORE" : "JOURNAL_AHEAD",
							now(),
						);
						return token;
					}));
				for (const scope of decision.scopes) {
					const outcome = await restoreScope(scope, epoch, entries);
					if (!outcome.ok) return closed(`RESTORE_${outcome.reason}`);
				}
				await adoptJournalEntries(entries);
				await store.write((db) =>
					writeRestore(db, epoch, "complete", null, now()),
				);
			}
			// World content of every accepted forget must be gone before the gate opens.
			const reports = await resumeForgets();
			const stuck = reports.filter(
				(r) => r.state === "pending" || r.state === "journaled",
			);
			if (stuck.length > 0)
				return closed(
					`FORGET_PENDING:${stuck[0]!.blocked ?? stuck[0]!.state.toUpperCase()}:${stuck.length}`,
				);
			// Fail closed: after a restore, a forget whose Memory confirmations cannot
			// be shown as complete (or checked at all) keeps the gate shut, even
			// though its World content is already deleted. The next recoverWorld()
			// without a restore finishes the confirmations and opens it.
			if (restored) {
				const unverified = await reverifyMemory();
				if (unverified.length > 0)
					return closed(
						`MEMORY_UNVERIFIED:${unverified[0]!.reason}:${unverified.length}`,
					);
			}
			// A concurrent recoverWorld() started meanwhile owns the final decision.
			if (recoveries === 1) options.gate?.open();
			const left = store.read((db) => ({
				pending: listOpenIntakes(db).map((row) => row.forgetId),
				abandoned: listAbandonedForgetIds(db),
			}));
			return {
				status: "open",
				restored,
				pendingForgets: left.pending,
				abandonedForgets: left.abandoned,
			};
		} catch (error) {
			const reason = transientReason(error);
			if (reason === null) {
				options.gate?.close("RECOVERY_FAILED");
				throw error;
			}
			return closed(reason);
		}
	}

	function recoverWorld(
		request: {
			/** A database restore is known (operator action). */
			restored?: boolean;
			/** Memory's recover() reported feedResyncRequired. */
			memoryFeedResyncRequired?: boolean;
		} = {},
	): Promise<RecoverReport> {
		recoveries += 1;
		// Closed from the moment the call is made, also while it waits its turn.
		options.gate?.close("RECOVERY_REQUIRED");
		const run = recoverTail.then(
			() => runRecover(request),
			() => runRecover(request),
		);
		const done = run.then(
			() => undefined,
			() => undefined,
		);
		recoverTail = done;
		return run.finally(() => {
			recoveries -= 1;
		});
	}

	return { recoverWorld };
}
