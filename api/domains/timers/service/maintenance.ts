import type { Database } from "bun:sqlite";
import { TIMER_EXPIRE_KIND } from "../contracts";
import {
	attachExpiryJob,
	findDueActive,
	getTimer,
	insertNotificationIfAbsent,
	markDispatchExhausted,
	pruneBatch,
} from "../repository";
import type { TimerDeps } from "./deps";
import { isOpenJob } from "./expiry";
import { releaseExpiredClaims } from "./notifications";
import { TIMER_POLICY } from "./policy";

export type MaintenanceState = { lastPruneAt: number };

export function maintenanceInTransaction(
	tx: Database,
	deps: TimerDeps,
	state: MaintenanceState = { lastPruneAt: Number.NEGATIVE_INFINITY },
) {
	const at = deps.now();
	for (const timer of findDueActive(tx, at, TIMER_POLICY.batchSize)) {
		const current = getTimer(tx, timer.id) ?? timer;
		const job = current.expiryJobId
			? deps.queue.getInTransaction(tx, current.expiryJobId)
			: null;
		if (job && isOpenJob(job.state)) continue;
		if (job && job.finishedAtMs !== null) {
			const n = current.dispatchGeneration;
			if (n >= TIMER_POLICY.redispatchMax) {
				if (
					markDispatchExhausted(
						tx,
						current.id,
						current.cancelEpoch,
						current.dispatchGeneration,
						at,
					)
				) {
					const stale = at - current.dueAtMs > TIMER_POLICY.soundFreshMs;
					insertNotificationIfAbsent(tx, {
						id: deps.id(),
						timerId: current.id,
						scope: current.scope,
						generation: current.cancelEpoch,
						dueAtMs: current.dueAtMs,
						status: stale ? "silent" : "pending",
						reason: stale ? "stale" : null,
						at,
					});
					deps.log.warn("timer.expiry_exhausted", {
						timerId: current.id,
						reason: "timer_dispatch_exhausted",
					});
				}
				continue;
			}
			const wait = Math.min(
				TIMER_POLICY.redispatchCapMs,
				TIMER_POLICY.redispatchBaseMs * 2 ** n,
			);
			if (at < job.finishedAtMs + wait) continue;
		}
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
	if (at - state.lastPruneAt < TIMER_POLICY.pruneEveryMs)
		return { operations: 0, timers: 0, deleted: 0 };
	state.lastPruneAt = at;
	const protectedIds = deps.protectedIds?.(tx) ?? [];
	return pruneBatch(
		tx,
		at,
		TIMER_POLICY.retentionMs,
		TIMER_POLICY.tombstoneMs,
		TIMER_POLICY.batchSize,
		protectedIds,
		TIMER_POLICY.listRetentionMs,
	);
}
