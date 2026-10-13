import type { Database } from "bun:sqlite";
import { cancelTimerSchema, type TimerReceipt } from "../contracts";
import {
	attachSchedule,
	countLive,
	countOperations,
	getTimer,
	markPaused,
	markResumed,
} from "../repository";
import { digest, iso } from "./canonical";
import type { TimerDeps } from "./deps";
import { toDto } from "./dto";
import {
	assertIssuedAt,
	cancelScheduleAndJob,
	parseInput,
	replayOf,
	saveOperation,
	type SavedReceipt,
} from "./operations";
import { TIMER_POLICY } from "./policy";

export function controlInTransaction(
	tx: Database,
	deps: TimerDeps,
	command: unknown,
	scope: string,
	timerId: string,
	operation: "pause" | "resume",
): SavedReceipt {
	const input = parseInput(cancelTimerSchema, command);
	const inputDigest = digest({
		operation,
		timerId,
		expectedRevision: input.expectedRevision,
	});
	const replay = replayOf(tx, scope, input.requestId, inputDigest);
	if (replay) return replay;
	const timer = getTimer(tx, timerId);
	if (!timer || timer.scope !== scope) throw new Error("timer_not_found");
	if (timer.bodyExpired) throw new Error("operation_expired");
	if (timer.revision !== input.expectedRevision)
		throw new Error("revision_conflict");
	const at = deps.now();
	const issuedAtMs = assertIssuedAt(input.issuedAt, at);
	if (countOperations(tx, scope) >= TIMER_POLICY.maxOperations)
		throw new Error("operation_capacity");
	let action: "paused" | "resumed" | "unchanged" = "unchanged";
	if (operation === "pause" && timer.state === "active" && timer.dueAtMs > at) {
		cancelScheduleAndJob(tx, deps, timer, "timer_paused");
		if (!markPaused(tx, timerId, timer.revision, at))
			throw new Error("revision_conflict");
		action = "paused";
	}
	if (operation === "resume") {
		if (timer.state !== "paused" && timer.state !== "cancelled")
			throw new Error("timer_not_resumable");
		const remainingMs =
			timer.pausedRemainingMs ??
			Math.max(0, timer.dueAtMs - (timer.cancelledAtMs ?? at));
		if (remainingMs <= 0) throw new Error("timer_not_resumable");
		if (
			timer.state === "cancelled" &&
			countLive(tx, scope) >= TIMER_POLICY.maxActive
		)
			throw new Error("timer_limit_reached");
		const dueAt = at + remainingMs;
		if (!markResumed(tx, timerId, timer.revision, dueAt, at))
			throw new Error("revision_conflict");
		const current = getTimer(tx, timerId)!;
		const schedule = deps.scheduler.createInTransaction(tx, {
			requestId: input.requestId,
			target: {
				kind: "timer.expire",
				payload: { timerId, cancelEpoch: current.cancelEpoch },
			},
			schedule: { type: "once", at: iso(dueAt) },
			misfirePolicy: "coalesce",
			graceMs: TIMER_POLICY.soundFreshMs,
		});
		if (!attachSchedule(tx, timerId, schedule.id))
			throw new Error("timer_unavailable");
		action = "resumed";
	}
	const current = getTimer(tx, timerId)!;
	const receipt: TimerReceipt = {
		kind: "timer_action",
		action,
		operationId: deps.id(),
		serverNow: iso(at),
		timer: toDto(current, at),
	};
	saveOperation(tx, deps, {
		scope,
		requestId: input.requestId,
		issuedAtMs,
		inputDigest,
		operation,
		timerId,
		originKey: null,
		receipt,
		at,
	});
	return { receipt, replay: false };
}
