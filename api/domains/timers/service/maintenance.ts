import type { Database } from "bun:sqlite";
import { TIMER_EXPIRE_KIND } from "../contracts";
import {
	attachExpiryJob,
	findDueActive,
	getTimer,
	pruneBatch,
} from "../repository";
import type { TimerDeps } from "./deps";
import { isOpenJob } from "./expiry";
import { releaseExpiredClaims } from "./notifications";
import { TIMER_POLICY } from "./policy";

export function maintenanceInTransaction(tx: Database, deps: TimerDeps) {
	const at = deps.now();
	for (const timer of findDueActive(tx, at, TIMER_POLICY.batchSize)) {
		const current = getTimer(tx, timer.id) ?? timer;
		const job = current.expiryJobId
			? deps.queue.getInTransaction(tx, current.expiryJobId)
			: null;
		if (job && isOpenJob(job.state)) continue;
		const schedule = current.scheduleId
			? deps.scheduler.getInTransaction(tx, current.scheduleId)
			: null;
		const scheduleState = schedule?.state ?? "missing";
		if (scheduleState === "active" || scheduleState === "paused") continue;
		const nextGeneration = current.dispatchGeneration + 1;
		tx.exec("SAVEPOINT timer_redispatch");
		try {
			const enqueued = deps.queue.enqueueInTransaction(tx, {
				scope: current.scope,
				kind: TIMER_EXPIRE_KIND,
				payloadVersion: 1,
				dedupeKey: `timer:${current.id}:${current.cancelEpoch}:dispatch:${nextGeneration}`,
				payload: {
					timerId: current.id,
					cancelEpoch: current.cancelEpoch,
					dispatchGeneration: nextGeneration,
				},
				subjectRef: current.id,
				lane: "background",
				maxAttempts: 3,
				deadlineAtMs: null,
			});
			if (
				!attachExpiryJob(
					tx,
					current.id,
					enqueued.job.id,
					current.dispatchGeneration,
					nextGeneration,
				)
			)
				throw new Error("timer_unavailable");
			deps.log.debug("timer.expiry_redispatched", {
				timerId: current.id,
				jobId: enqueued.job.id,
				generation: nextGeneration,
				status: "active",
			});
			tx.exec("RELEASE timer_redispatch");
		} catch (error) {
			tx.exec("ROLLBACK TO timer_redispatch");
			tx.exec("RELEASE timer_redispatch");
			if (!(error instanceof Error) || error.message !== "queue_full")
				throw error;
			// Capacity delays this timer; it must not block lease recovery or retention.
		}
	}
	releaseExpiredClaims(tx, deps);
	const protectedIds = deps.protectedIds?.(tx) ?? [];
	return pruneBatch(
		tx,
		at,
		TIMER_POLICY.retentionMs,
		TIMER_POLICY.tombstoneMs,
		TIMER_POLICY.batchSize,
		protectedIds,
	);
}
