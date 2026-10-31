import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";
import {
	getIntake,
	listIntakesOfScope,
	type IntakeRow,
} from "../repository/lifecycle";
import { createFeedOps } from "./lifecycle-feed";
import { createForgetOps } from "./lifecycle-forget";
import { createLifecycleCtx } from "./lifecycle-lock";
import { createRecoverOps } from "./lifecycle-recover";
import { createRestoreOps } from "./lifecycle-restore";
import type {
	ForgetListItem,
	ForgetRefusal,
	ForgetReport,
	ForgetRequest,
	LifecycleOptions,
} from "./lifecycle-types";
import { sweepReleasePending } from "./usage-ledger";
export type {
	ConsumeReport,
	ForgetListItem,
	ForgetRefusal,
	ForgetReport,
	ForgetRequest,
	LifecycleOptions,
	RecoverReport,
} from "./lifecycle-types";

/**
 * World forget / restore lifecycle on the host side (P3-05). It owns the
 * forget intake state machine, the World journal, the restore procedure and
 * the two change-feed consumers. Everything that touches World or Memory
 * data runs in the host's single Writer callback; nothing here opens a
 * transaction of its own. Memory is reached only through its public sqlite
 * API (MemoryPort).
 */
export function createWorldLifecycle(options: LifecycleOptions) {
	const ctx = createLifecycleCtx(options);
	const { store, reportOf, unregisterFor, acceptInWriter } = ctx;
	const forget = createForgetOps(ctx);
	const restore = createRestoreOps(ctx, forget);
	const recover = createRecoverOps(ctx, forget, restore);
	const feed = createFeedOps(ctx, forget);

	const itemOf = (db: Database, row: IntakeRow): ForgetListItem => ({
		...reportOf(db, row),
		origin: row.origin,
		rootCount: row.roots.length,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	});

	return {
		/** Durable intake, then World journal, World forget, Memory confirmation, reopen. */
		acceptForget: forget.acceptForget,
		/** Resume one forget from wherever it stopped. */
		resumeForget: forget.advance,
		/**
		 * Only the durable intake, in the caller's writer transaction. The caller resumes the
		 * forget (`resumeForget`) once that transaction has committed; until then it is pending.
		 */
		acceptForgetInTransaction: (
			db: Database,
			request: ForgetRequest,
		): ForgetRefusal | ForgetListItem => {
			const accepted = acceptInWriter(db, request);
			if ("status" in accepted) return accepted;
			return itemOf(db, getIntake(db, accepted.forgetId)!);
		},
		/** One forget of a Scope as this connection sees it, or null (unknown, or another Scope). */
		forgetItemInTransaction: (
			db: Database,
			scope: ScopeRef,
			forgetId: string,
		): ForgetListItem | null => {
			const row = getIntake(db, forgetId);
			return row &&
				row.principal === scope.principal &&
				row.scopeKey === scope.scopeKey
				? itemOf(db, row)
				: null;
		},
		/** Resume every forget that is not complete (also done by recoverWorld). */
		resumeForgets: forget.resumeForgets,
		forgetStatus: (forgetId: string): ForgetReport | null =>
			store.read((db) => {
				const row = getIntake(db, forgetId);
				return row ? reportOf(db, row) : null;
			}),
		/**
		 * Every forget of ONE Scope, newest first, from the durable intake: it
		 * survives a restart and does not depend on World being ON or the Scope
		 * gate being open. `world`/`externals` are only known to a call that
		 * advanced the forget, so they are null here.
		 */
		listForgets: (scope: ScopeRef, limit = 50): ForgetListItem[] =>
			store.read((db) =>
				listIntakesOfScope(
					db,
					scope.principal,
					scope.scopeKey,
					Math.max(1, Math.min(limit, 200)),
				).map((row) => itemOf(db, row)),
			),
		recoverWorld: recover.recoverWorld,
		/**
		 * Retry sweep for Memory dependents whose unregistration was refused
		 * (host rows marked release_pending). Idempotent, never throws on Memory.
		 */
		sweepPendingReleases: (limit = 200) =>
			store.write((db) =>
				sweepReleasePending(db, limit, (scope) => unregisterFor(db, scope)),
			),
		/** Explicit restore: same procedure as a detected one. */
		startRestore: () => recover.recoverWorld({ restored: true }),
		consumeMemoryChanges: feed.consumeMemoryChanges,
		consumeSourceChanges: feed.consumeSourceChanges,
		/** Each checkpoint stage of both feeds (owner, scanned, received, applied). */
		feedStages: feed.feedStages,
	};
}
export type WorldLifecycle = ReturnType<typeof createWorldLifecycle>;
