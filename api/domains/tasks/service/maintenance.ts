import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import * as repo from "../repository";
import type { TaskCore } from "./core";
import { syncHook } from "./helpers";
import type { createTaskLifecycle } from "./lifecycle";

const log = getLogger("tasks");
/** Rows are deleted this long after finishing; metadata expires at 30 days. */
const PURGE_AFTER_MS = 90 * 86_400_000;
const PURGE_BATCH = 50;
/** A task whose purge failed is skipped this long, so it cannot starve newer ones. */
const PURGE_RETRY_MS = 3_600_000;

/** Expiry, cleanup and restart recovery. */
export function createTaskMaintenance(
	core: TaskCore,
	lifecycle: ReturnType<typeof createTaskLifecycle>,
) {
	const { now, kindFor, record } = core;
	const { purgeInTransaction } = core.options;
	/** Per process: task id -> earliest time to retry a failed purge. */
	const purgeRetryAt = new Map<string, number>();
	const { stopTask, settleStopInTransaction } = lifecycle;
	function cleanupInTransaction(tx: Database) {
		let expired = 0;
		for (const t of repo.expiredBodies(tx, now() - 7 * 86_400_000, 100)) {
			t.request = null;
			t.completionConditions = [];
			t.bodyExpired = true;
			repo.clearPrivateHistory(tx, t.id);
			record(tx, t, "body_expired");
			expired++;
		}
		for (const t of repo.expiredMetadata(tx, now() - 30 * 86_400_000)) {
			t.metadataExpired = true;
			record(tx, t, "metadata_expired");
			repo.clearRuntimeHistory(tx, t);
		}
		for (const [id, at] of purgeRetryAt)
			if (at <= now()) purgeRetryAt.delete(id);
		for (const t of repo.purgeCandidates(
			tx,
			now() - PURGE_AFTER_MS,
			PURGE_BATCH,
			[...purgeRetryAt.keys()],
		)) {
			tx.exec("SAVEPOINT task_purge");
			try {
				syncHook(purgeInTransaction?.(tx, t));
				syncHook(kindFor(t)?.purgeInTransaction?.(tx, t));
				repo.purgeTask(tx, t.id);
				tx.exec("RELEASE task_purge");
				purgeRetryAt.delete(t.id);
			} catch (error) {
				purgeRetryAt.set(t.id, now() + PURGE_RETRY_MS);
				tx.exec("ROLLBACK TO task_purge");
				tx.exec("RELEASE task_purge");
				log.warn(
					"tasks.purge_failed",
					{ reason: "purge_failed", taskId: t.id },
					error,
				);
			}
		}
		return expired;
	}
	function maintenanceInTransaction(tx: Database) {
		for (const t of repo.live(tx)) {
			const expired =
				Date.parse(t.grant.expiresAt) <= now() ||
				(t.executionDeadlineAt !== null &&
					Date.parse(t.executionDeadlineAt) <= now());
			if (t.state === "stopping" && !(t.stopIntent === "pause" && expired))
				syncHook(kindFor(t)?.stopInTransaction(tx, t));
			else if (expired) {
				const executionStopped =
					t.state === "paused" || t.executionGeneration === 0;
				stopTask(
					tx,
					t,
					"cancel",
					Date.parse(t.grant.expiresAt) <= now()
						? "grant_expired"
						: "runtime_budget_expired",
				);
				if (executionStopped)
					settleStopInTransaction(tx, {
						taskId: t.id,
						expectedRevision: t.revision,
						authorityEpoch: t.authorityEpoch,
						executionGeneration: t.executionGeneration,
					});
			}
		}
		return cleanupInTransaction(tx);
	}
	function recoverInTransaction(tx: Database) {
		maintenanceInTransaction(tx);
		// Without a runner receipt, previously started work is unknown, never replayed.
		for (const t of repo.live(tx))
			if (["queued", "active", "waiting_user"].includes(t.state)) {
				if (t.kind === "orchestration" && t.state === "waiting_user") continue;
				t.state = "reconciling";
				const q = repo.openQuestion(tx, t.id);
				if (q) repo.putQuestion(tx, { ...q, state: "superseded" });
				record(tx, t, "recovery_requires_receipt");
			}
		return { live: repo.live(tx).length };
	}
	return { maintenanceInTransaction, recoverInTransaction };
}
