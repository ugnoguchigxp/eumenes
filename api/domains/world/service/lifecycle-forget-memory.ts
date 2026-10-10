import type { Database } from "bun:sqlite";
import { type ScopeRef } from "eumenes-world-model";
import {
	advanceIntake,
	countUnconfirmed,
	getDependent,
	getIntake,
	listConfirmations,
	listIntakesOfMemoryForget,
	setBlockedReason,
	stateAtLeast,
	upsertConfirmation,
	type IntakeRow,
} from "../repository/lifecycle";
import { listAbandoned, type AbandonedPart } from "../repository/guard";
import type { ForgetReport } from "./lifecycle-types";
import {
	StepBlocked,
	why,
	scopeOf,
	forgetKey,
	partId,
	partCount,
} from "./lifecycle-shared";
import type { LifecycleCtx } from "./lifecycle-lock";

export function createMemorySteps(ctx: LifecycleCtx) {
	const { store, now, memory, confirmBatch, hook, accessFor, worldOp } = ctx;

	// --- step 4: Memory external deletions ---------------------------------------

	/**
	 * Roots (source/state keys) the intakes of one Memory forget have erased from
	 * World: only intakes whose World deletion is verified count.
	 */
	function erasedKeys(db: Database, memoryForgetId: string): Set<string> {
		const keys = new Set<string>();
		for (const intake of listIntakesOfMemoryForget(db, memoryForgetId)) {
			if (!stateAtLeast(intake.state, "world_applied")) continue;
			for (const root of intake.roots)
				if (root.kind === "source" || root.kind === "state") keys.add(root.id);
		}
		return keys;
	}

	/**
	 * May Memory be told that World deleted this external? Only when World
	 * content standing on it is gone: the host row is gone (released / purged),
	 * the row waits for its release, or an input it stood on is among the roots
	 * erased for this Memory forget (World erases every version that stands on
	 * an erased root, whatever its other inputs are). A forget with unrelated
	 * roots therefore confirms nothing.
	 */
	function externalErased(
		db: Database,
		scope: ScopeRef,
		externalId: string,
		erased: ReadonlySet<string>,
	): boolean {
		const dependent = getDependent(
			db,
			scope.principal,
			scope.scopeKey,
			externalId,
		);
		if (dependent === null || dependent.releasePending) return true;
		return dependent.dependsOn.some((d) => erased.has(d.key));
	}

	/**
	 * Reads Memory's receipt, syncs the per-externalId rows to it (a row Memory
	 * no longer shows as confirmed goes back to pending) and sorts what is
	 * still owed: `confirmable` (the World content is verifiably gone) and
	 * `uncovered` (the roots given do not reach it: never confirmed). Needs the
	 * World deletion to be verified (state world_applied or later).
	 */
	function syncConfirmations(
		db: Database,
		row: IntakeRow,
	): { confirmable: string[]; uncovered: string[]; total: number } {
		const mid = row.memoryForgetId!;
		const receipt = memory.receipt(db, accessFor(db, scopeOf(row)), mid);
		if (receipt.status === "missing")
			throw new StepBlocked("MEMORY_RECEIPT_MISSING");
		if (receipt.status !== "found")
			throw new StepBlocked("MEMORY_NOT_PERMITTED");
		for (const external of receipt.externals)
			upsertConfirmation(
				db,
				mid,
				external.externalId,
				external.state === "confirmed" ? "confirmed" : "pending",
				now(),
			);
		const rows = listConfirmations(db, mid);
		const erased = erasedKeys(db, mid);
		const scope = scopeOf(row);
		const confirmable: string[] = [];
		const uncovered: string[] = [];
		for (const r of rows) {
			if (r.state === "confirmed") continue;
			(externalErased(db, scope, r.externalId, erased)
				? confirmable
				: uncovered
			).push(r.externalId);
		}
		return { confirmable, uncovered, total: rows.length };
	}

	/** Every intake of this Memory forget has deleted its World content, and the last batch is the final one. */
	const groupReady = (db: Database, memoryForgetId: string): boolean => {
		const group = listIntakesOfMemoryForget(db, memoryForgetId);
		return (
			group.length > 0 &&
			group.every((r) => stateAtLeast(r.state, "world_applied")) &&
			group[group.length - 1]!.memoryFinal
		);
	};

	async function memoryStep(
		intake: IntakeRow,
	): Promise<{ externals: ForgetReport["externals"]; blocked: string | null }> {
		if (intake.memoryForgetId === null) {
			await store.write((db) => {
				advanceIntake(
					db,
					intake.forgetId,
					"world_applied",
					"memory_confirmed",
					now(),
				);
			});
			hook("memory_confirmed", intake.forgetId);
			return { externals: null, blocked: null };
		}
		const mid = intake.memoryForgetId;
		let externals: ForgetReport["externals"] = null;
		try {
			// Phase 1: read Memory's receipt and sync rows; refuse while the group is incomplete.
			const first = await store.write((db) => {
				const row = getIntake(db, intake.forgetId);
				if (!row || row.state !== "world_applied")
					return {
						confirmable: [] as string[],
						uncovered: [] as string[],
						total: 0,
						skip: true,
					};
				if (!groupReady(db, mid))
					throw new StepBlocked("WAITING_FOR_FORGET_GROUP");
				return { ...syncConfirmations(db, row), skip: false };
			});
			if (first.skip) return { externals, blocked: null };
			externals = {
				total: first.total,
				confirmed:
					first.total - first.confirmable.length - first.uncovered.length,
			};
			// Phase 2: confirm in bounded batches, each its own transaction.
			let pending = first.confirmable;
			while (pending.length > 0) {
				const batch = pending.slice(0, confirmBatch);
				const rest = await store.write((db) => {
					const row = getIntake(db, intake.forgetId);
					if (!row || row.state !== "world_applied") return pending;
					const access = accessFor(db, scopeOf(row));
					for (const externalId of batch) {
						const outcome = memory.record(db, access, now(), {
							forgetId: mid,
							externalId,
							state: "confirmed",
						});
						if (outcome !== "recorded")
							throw new StepBlocked(`MEMORY_${outcome.toUpperCase()}`);
						upsertConfirmation(db, mid, externalId, "confirmed", now());
					}
					return pending.slice(batch.length);
				});
				pending = rest;
				externals = {
					total: first.total,
					confirmed: first.total - pending.length - first.uncovered.length,
				};
				hook("memory_batch", intake.forgetId);
			}
			// Phase 3: re-read Memory; only a receipt that shows everything confirmed moves on.
			await store.write((db) => {
				const row = getIntake(db, intake.forgetId);
				if (!row || row.state !== "world_applied") return;
				const check = syncConfirmations(db, row);
				if (check.uncovered.length > 0)
					throw new StepBlocked("MEMORY_EXTERNAL_NOT_COVERED");
				if (check.confirmable.length > 0 || countUnconfirmed(db, mid) > 0)
					throw new StepBlocked("MEMORY_UNCONFIRMED");
				advanceIntake(
					db,
					row.forgetId,
					"world_applied",
					"memory_confirmed",
					now(),
				);
			});
			hook("memory_confirmed", intake.forgetId);
			return { externals, blocked: null };
		} catch (error) {
			// Keep what was confirmed so far in the report; the rest stays owed.
			if (error instanceof StepBlocked)
				return { externals, blocked: error.reason };
			throw error;
		}
	}

	// --- step 5: reopen -----------------------------------------------------------

	async function reopenStep(intake: IntakeRow): Promise<string | null> {
		hook("before_reopen", intake.forgetId);
		return store.write((db) => {
			const row = getIntake(db, intake.forgetId);
			if (!row || row.state !== "memory_confirmed") return null;
			if (
				row.memoryForgetId !== null &&
				countUnconfirmed(db, row.memoryForgetId) > 0
			)
				throw new StepBlocked("MEMORY_UNCONFIRMED");
			if (row.origin !== "restored") {
				// A part World refused outright never became a World forget.
				const absent = new Set(
					listAbandoned(db, row.forgetId)
						.filter((a: AbandonedPart) => a.wholePart)
						.map((a) => a.part),
				);
				for (let part = 0; part < partCount(row); part++) {
					if (absent.has(part)) continue;
					const id = partId(row.forgetId, part);
					const result = worldOp(db, scopeOf(row), forgetKey(id, "ro", 0), {
						kind: "forget.reopen",
						forgetId: id,
						externalDeletionConfirmed: true,
					});
					const done =
						result.status === "applied" ||
						result.status === "no_op" ||
						(result.status === "blocked" &&
							result.reasonCode === "FORGET_NOT_AWAITING");
					if (!done) {
						const reason = `WORLD_${why(result)}`;
						setBlockedReason(db, row.forgetId, reason, now());
						return reason;
					}
				}
			}
			advanceIntake(db, row.forgetId, "memory_confirmed", "complete", now());
			return null;
		});
	}

	return { syncConfirmations, memoryStep, reopenStep };
}
