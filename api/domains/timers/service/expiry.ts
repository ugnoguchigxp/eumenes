import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { HandlerDefinition, JobClaim } from "../../queue";
import { openStates } from "../../queue/contracts";
import { TIMER_EXPIRE_KIND, type TimerNotificationDto } from "../contracts";
import {
	attachExpiryJob,
	getTimer,
	insertNotificationIfAbsent,
	markElapsed,
	setTimerError,
	type NotificationRow,
} from "../repository";
import { TIMER_POLICY } from "./policy";
import { iso } from "./canonical";
import type { TimerDeps } from "./deps";

export const expireTargetSchema = z
	.object({
		timerId: z.uuid(),
		cancelEpoch: z.number().int().min(0),
	})
	.strict();

export const expireJobSchema = z
	.object({
		timerId: z.uuid(),
		cancelEpoch: z.number().int().min(0),
		dispatchGeneration: z.number().int().min(1),
	})
	.strict();

type ExpireInput = {
	id: string;
	epoch: number;
	dispatchGeneration: number;
};

export function notificationDto(row: NotificationRow): TimerNotificationDto {
	return {
		id: row.id,
		timerId: row.timerId,
		generation: row.generation,
		revision: row.revision,
		status: row.status,
		reason: row.reason,
		dueAt: iso(row.dueAtMs),
	};
}

export function createExpiry(deps: TimerDeps) {
	const target = {
		kind: TIMER_EXPIRE_KIND,
		version: 1,
		schema: expireTargetSchema,
		materializeInTransaction(
			tx: Database,
			occurrence: {
				scheduleId: string;
				occurrenceId: string;
				scheduledAtMs: number;
				payload: z.infer<typeof expireTargetSchema>;
			},
		) {
			const timer = getTimer(tx, occurrence.payload.timerId);
			if (
				!timer ||
				timer.state !== "active" ||
				timer.cancelEpoch !== occurrence.payload.cancelEpoch
			)
				throw new Error("timer_not_active");
			if (timer.dueAtMs > deps.now()) throw new Error("timer_not_due");
			const nextGeneration = timer.dispatchGeneration + 1;
			const enqueued = deps.queue.enqueueInTransaction(tx, {
				scope: timer.scope,
				kind: TIMER_EXPIRE_KIND,
				payloadVersion: 1,
				dedupeKey: `timer:${timer.id}:${timer.cancelEpoch}:dispatch:${nextGeneration}`,
				payload: {
					timerId: timer.id,
					cancelEpoch: timer.cancelEpoch,
					dispatchGeneration: nextGeneration,
				},
				subjectRef: timer.id,
				lane: "background",
				maxAttempts: 3,
				deadlineAtMs: null,
			});
			if (
				!attachExpiryJob(
					tx,
					timer.id,
					enqueued.job.id,
					timer.dispatchGeneration,
					nextGeneration,
				)
			)
				throw new Error("timer_unavailable");
			return { jobId: enqueued.job.id, subjectRef: timer.id };
		},
	};

	const handler: HandlerDefinition<
		z.infer<typeof expireJobSchema>,
		ExpireInput,
		ExpireInput
	> = {
		kind: TIMER_EXPIRE_KIND,
		payloadVersions: [1],
		schema: expireJobSchema,
		recovery: "replay_safe",
		prepareInTransaction(tx, claim) {
			const ready = readyTimer(tx, claim.payload, deps.now());
			if (!ready) return { status: "stale", reason: "timer_stale" };
			return {
				status: "ready",
				input: {
					id: ready.id,
					epoch: ready.cancelEpoch,
					dispatchGeneration: ready.dispatchGeneration,
				},
			};
		},
		async execute(input) {
			return input;
		},
		settleInTransaction(tx, claim, input, outcome) {
			const at = deps.now();
			if (outcome.type !== "success") {
				const code =
					outcome.type === "failed" ||
					outcome.type === "retry" ||
					outcome.type === "interrupted"
						? outcome.errorCode
						: "timer_expire_failed";
				const timer = getTimer(tx, claim.payload.timerId);
				if (timer?.state === "active") setTimerError(tx, timer.id, code, at);
				return "applied";
			}
			if (
				!input ||
				input.id !== claim.payload.timerId ||
				input.epoch !== claim.payload.cancelEpoch ||
				input.dispatchGeneration !== claim.payload.dispatchGeneration
			)
				return "stale";
			const timer = getTimer(tx, input.id);
			if (
				!timer ||
				timer.state !== "active" ||
				timer.cancelEpoch !== input.epoch ||
				timer.dispatchGeneration !== input.dispatchGeneration ||
				timer.dueAtMs > at
			)
				return "stale";
			if (
				!markElapsed(
					tx,
					timer.id,
					timer.cancelEpoch,
					timer.dispatchGeneration,
					at,
					at,
				)
			)
				return "stale";
			const stale = at - timer.dueAtMs > TIMER_POLICY.soundFreshMs;
			insertNotificationIfAbsent(tx, {
				id: deps.id(),
				timerId: timer.id,
				scope: timer.scope,
				generation: timer.cancelEpoch,
				dueAtMs: timer.dueAtMs,
				status: stale ? "silent" : "pending",
				reason: stale ? "stale" : null,
				at,
			});
			deps.log.debug("timer.elapsed", {
				timerId: timer.id,
				jobId: claim.jobId,
				status: stale ? "silent" : "pending",
				durationMs: at - timer.dueAtMs,
			});
			return "applied";
		},
		cancelInTransaction() {},
		afterCommit() {
			deps.publish?.();
		},
	};

	return { target, handler };
}

function readyTimer(
	tx: Database,
	payload: z.infer<typeof expireJobSchema>,
	now: number,
) {
	const timer = getTimer(tx, payload.timerId);
	if (
		!timer ||
		timer.state !== "active" ||
		timer.cancelEpoch !== payload.cancelEpoch ||
		timer.dispatchGeneration !== payload.dispatchGeneration ||
		timer.dueAtMs > now
	)
		return null;
	return timer;
}

export function isOpenJob(state: string) {
	return (openStates as readonly string[]).includes(state);
}

export type ExpireClaim = JobClaim<z.infer<typeof expireJobSchema>>;
