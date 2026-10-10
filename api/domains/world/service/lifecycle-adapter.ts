import type { ScopeRef } from "eumenes-world-model";
import { getIntake, listIntakesOfScope } from "../repository/lifecycle";
import { createFeedOps } from "./lifecycle-feed";
import { createForgetOps } from "./lifecycle-forget";
import { createLifecycleCtx } from "./lifecycle-lock";
import { createRecoverOps } from "./lifecycle-recover";
import { createRestoreOps } from "./lifecycle-restore";
import type {
	ForgetListItem,
	ForgetReport,
	LifecycleOptions,
} from "./lifecycle-types";
import { sweepReleasePending } from "./usage-ledger";

export { isValidRoot } from "./lifecycle-shared";
export type {
	ConsumeReport,
	ForgetListItem,
	ForgetRefusal,
	ForgetReport,
	ForgetRequest,
	LifecycleOptions,
	LifecyclePoint,
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
	const { store, reportOf, unregisterFor } = ctx;
	const forget = createForgetOps(ctx);
	const restore = createRestoreOps(ctx, forget);
	const recover = createRecoverOps(ctx, forget, restore);
	const feed = createFeedOps(ctx, forget);

	return {
		/** Durable intake, then World journal, World forget, Memory confirmation, reopen. */
		acceptForget: forget.acceptForget,
		/** Resume one forget from wherever it stopped. */
		resumeForget: forget.advance,
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
				).map((row) => ({
					...reportOf(db, row),
					origin: row.origin,
					rootCount: row.roots.length,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt,
				})),
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
