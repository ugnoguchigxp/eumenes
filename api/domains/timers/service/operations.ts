import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	DEFAULT_TIMER_LABEL,
	type CancelTimerInput,
	type ListTimersQuery,
	type StartTimerInput,
	type TimerOrigin,
	type TimerReceipt,
	type TimerState,
	cancelTimerSchema,
	listTimersQuerySchema,
	startTimerSchema,
} from "../contracts";
import {
	attachSchedule,
	countActive,
	countOperations,
	countTimers,
	getOperationByRequest,
	getStartReceiptByOrigin,
	getTimer,
	getTimerByOrigin,
	insertOperation,
	insertTimer,
	listTimers,
	markCancelled,
	bumpEpoch,
	dismissNotifications,
	undismissedCount,
	type OperationRow,
	type TimerRow,
} from "../repository";
import { canonical, digest, iso } from "./canonical";
import type { TimerDeps } from "./deps";
import { toDto } from "./dto";
import { isOpenJob } from "./expiry";
import { TIMER_POLICY } from "./policy";

const createdCursor = z
	.object({ createdAtMs: z.number().int(), id: z.uuid() })
	.strict();

export type SavedReceipt = { receipt: TimerReceipt; replay: boolean };

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new Error("invalid_timer_input");
	return parsed.data;
}

function assertIssuedAt(issuedAt: string, nowMs: number) {
	const issued = Date.parse(issuedAt);
	if (!Number.isFinite(issued)) throw new Error("invalid_timer_input");
	if (nowMs - issued > TIMER_POLICY.requestMaxAgeMs)
		throw new Error("invalid_timer_input");
	if (issued - nowMs > TIMER_POLICY.requestFutureToleranceMs)
		throw new Error("invalid_timer_input");
	return issued;
}

function readReceipt(row: OperationRow): TimerReceipt {
	if (row.expiredAtMs !== null || !row.receiptJson)
		throw new Error("operation_expired");
	return JSON.parse(row.receiptJson) as TimerReceipt;
}

function replayOf(
	tx: Database,
	scope: string,
	requestId: string,
	inputDigest: string,
): SavedReceipt | null {
	const existing = getOperationByRequest(tx, scope, requestId);
	if (!existing) return null;
	if (existing.expiredAtMs !== null) throw new Error("operation_expired");
	if (existing.inputDigest !== inputDigest) throw new Error("request_conflict");
	return { receipt: readReceipt(existing), replay: true };
}

function saveOperation(
	tx: Database,
	deps: TimerDeps,
	row: {
		scope: string;
		requestId: string;
		issuedAtMs: number;
		inputDigest: string;
		operation: "start" | "list" | "cancel";
		timerId: string | null;
		originKey: string | null;
		receipt: TimerReceipt;
		at: number;
	},
) {
	const receiptJson = canonical(row.receipt);
	insertOperation(tx, {
		id: row.receipt.operationId,
		scope: row.scope,
		requestId: row.requestId,
		issuedAtMs: row.issuedAtMs,
		inputDigest: row.inputDigest,
		operation: row.operation,
		timerId: row.timerId,
		originKey: row.originKey,
		receiptJson,
		receiptDigest: digest(row.receipt),
		createdAtMs: row.at,
	});
	deps.log.debug("timer.operation_saved", {
		timerId: row.timerId ?? undefined,
		operationId: row.receipt.operationId,
		runId: undefined,
		status: row.receipt.action,
	});
}

export function encodeCreatedCursor(createdAtMs: number, id: string) {
	return Buffer.from(JSON.stringify({ createdAtMs, id })).toString("base64url");
}

export function decodeCreatedCursor(cursor: string | undefined) {
	if (!cursor) return null;
	try {
		const parsed = createdCursor.safeParse(
			JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
		);
		if (!parsed.success) throw new Error("invalid_cursor");
		return parsed.data;
	} catch (error) {
		if (error instanceof Error && error.message === "invalid_cursor") throw error;
		throw new Error("invalid_cursor");
	}
}

function page(
	tx: Database,
	scope: string,
	query: {
		state?: TimerState | null;
		conversationId?: string | null;
		timerId?: string | null;
		cursor?: string;
		limit?: number;
	},
	nowMs: number,
) {
	const limit = Math.min(
		TIMER_POLICY.listMax,
		Math.max(1, query.limit ?? TIMER_POLICY.listDefault),
	);
	const cursor = decodeCreatedCursor(query.cursor);
	const rows = listTimers(tx, {
		scope,
		state: query.state,
		conversationId: query.conversationId,
		timerId: query.timerId,
		cursorCreatedAtMs: cursor?.createdAtMs,
		cursorId: cursor?.id,
		limit: limit + 1,
	});
	const pageRows = rows.slice(0, limit);
	const last = pageRows.at(-1);
	return {
		serverNow: iso(nowMs),
		items: pageRows.map((row) => toDto(row, nowMs)),
		nextCursor:
			rows.length > limit && last
				? encodeCreatedCursor(last.createdAtMs, last.id)
				: null,
	};
}

export function startInTransaction(
	tx: Database,
	deps: TimerDeps,
	command: unknown,
	origin: TimerOrigin,
): SavedReceipt {
	const input = parseInput(startTimerSchema, command);
	const label = input.label ?? DEFAULT_TIMER_LABEL;
	const inputDigest = digest({
		operation: "start",
		durationSeconds: input.durationSeconds,
		label,
		originKey: origin.originKey,
	});
	const replay = replayOf(tx, origin.scope, input.requestId, inputDigest);
	if (replay) return replay;
	const issuedAtMs = assertIssuedAt(input.issuedAt, deps.now());
	if (origin.originKey) {
		const prior = getTimerByOrigin(tx, origin.scope, origin.originKey);
		if (prior) {
			if (prior.durationSeconds !== input.durationSeconds || prior.label !== label)
				throw new Error("request_conflict");
			const stored = getStartReceiptByOrigin(tx, origin.scope, origin.originKey);
			if (!stored) throw new Error("operation_expired");
			return { receipt: readReceipt(stored), replay: true };
		}
	}
	if (countActive(tx, origin.scope) >= TIMER_POLICY.maxActive)
		throw new Error("timer_limit_reached");
	if (countTimers(tx, origin.scope) >= TIMER_POLICY.maxRows)
		throw new Error("timer_storage_full");
	if (countOperations(tx, origin.scope) >= TIMER_POLICY.maxOperations)
		throw new Error("operation_capacity");
	const at = deps.now();
	const id = deps.id();
	const operationId = deps.id();
	const dueAtMs = at + input.durationSeconds * 1000;
	insertTimer(tx, {
		id,
		scope: origin.scope,
		conversationId: origin.conversationId,
		originRunId: origin.runId,
		originMessageId: origin.messageId,
		originKey: origin.originKey,
		label,
		durationSeconds: input.durationSeconds,
		startedAtMs: at,
		dueAtMs,
		createdAtMs: at,
	});
	const schedule = deps.scheduler.createInTransaction(tx, {
		requestId: input.requestId,
		target: {
			kind: "timer.expire",
			payload: { timerId: id, cancelEpoch: 0 },
		},
		schedule: { type: "once", at: iso(dueAtMs) },
		misfirePolicy: "coalesce",
		graceMs: TIMER_POLICY.soundFreshMs,
	});
	if (!attachSchedule(tx, id, schedule.id)) throw new Error("timer_unavailable");
	const timer = getTimer(tx, id);
	if (!timer) throw new Error("timer_unavailable");
	const receipt: TimerReceipt = {
		kind: "timer_action",
		action: "started",
		operationId,
		serverNow: iso(at),
		timer: toDto(timer, at),
		artifact: { kind: "timer", version: 1, timerId: id },
	};
	saveOperation(tx, deps, {
		scope: origin.scope,
		requestId: input.requestId,
		issuedAtMs,
		inputDigest,
		operation: "start",
		timerId: id,
		originKey: origin.originKey,
		receipt,
		at,
	});
	deps.log.debug("timer.started", {
		timerId: id,
		operationId,
		runId: origin.runId ?? undefined,
		status: "active",
		durationMs: input.durationSeconds * 1000,
	});
	return { receipt, replay: false };
}

export function listInTransaction(
	tx: Database,
	deps: TimerDeps,
	query: ListTimersQuery,
	scope: string,
) {
	const nowMs = deps.now();
	return page(tx, scope, query, nowMs);
}

export function recordListOperationInTransaction(
	tx: Database,
	deps: TimerDeps,
	command: {
		requestId: string;
		issuedAt: string;
		timerId?: string;
		state?: TimerState;
	},
	scope: string,
): SavedReceipt {
	const inputDigest = digest({
		operation: "list",
		timerId: command.timerId ?? null,
		state: command.state ?? null,
	});
	const replay = replayOf(tx, scope, command.requestId, inputDigest);
	if (replay) return replay;
	const issuedAtMs = assertIssuedAt(command.issuedAt, deps.now());
	if (countOperations(tx, scope) >= TIMER_POLICY.maxOperations)
		throw new Error("operation_capacity");
	const at = deps.now();
	const listed = page(
		tx,
		scope,
		{
			state: command.timerId ? null : (command.state ?? "active"),
			timerId: command.timerId ?? null,
		},
		at,
	);
	const receipt: TimerReceipt = {
		kind: "timer_action",
		action: "listed",
		operationId: deps.id(),
		serverNow: listed.serverNow,
		items: listed.items,
		nextCursor: listed.nextCursor,
	};
	saveOperation(tx, deps, {
		scope,
		requestId: command.requestId,
		issuedAtMs,
		inputDigest,
		operation: "list",
		timerId: command.timerId ?? null,
		originKey: null,
		receipt,
		at,
	});
	return { receipt, replay: false };
}

export function cancelInTransaction(
	tx: Database,
	deps: TimerDeps,
	command: unknown,
	scope: string,
	timerId: string,
): SavedReceipt {
	const input = parseInput(cancelTimerSchema, command);
	const inputDigest = digest({
		operation: "cancel",
		timerId,
		expectedRevision: input.expectedRevision,
	});
	const replay = replayOf(tx, scope, input.requestId, inputDigest);
	if (replay) return replay;
	const timer = getTimer(tx, timerId);
	if (!timer || timer.scope !== scope) throw new Error("timer_not_found");
	if (timer.revision !== input.expectedRevision)
		throw new Error("revision_conflict");
	const issuedAtMs = assertIssuedAt(input.issuedAt, deps.now());
	const at = deps.now();
	if (timer.state === "active") {
		assertCancelCapacity(tx, scope);
		cancelScheduleAndJob(tx, deps, timer);
		dismissNotifications(tx, timer.id, at);
		if (!markCancelled(tx, timer.id, scope, timer.revision, at))
			throw new Error("revision_conflict");
		return persistCancel(tx, deps, input, issuedAtMs, inputDigest, scope, timer.id, at, "cancelled");
	}
	if (timer.state === "elapsed" && undismissedCount(tx, timer.id) > 0) {
		assertCancelCapacity(tx, scope);
		dismissNotifications(tx, timer.id, at);
		if (!bumpEpoch(tx, timer.id, scope, timer.revision, "elapsed", at))
			throw new Error("revision_conflict");
		return persistCancel(tx, deps, input, issuedAtMs, inputDigest, scope, timer.id, at, "dismissed");
	}
	return persistUnchanged(tx, deps, input, issuedAtMs, inputDigest, scope, timer, at);
}

function assertCancelCapacity(tx: Database, scope: string) {
	if (
		countOperations(tx, scope) >=
		TIMER_POLICY.maxOperations + TIMER_POLICY.cancelReserve
	)
		throw new Error("operation_capacity");
}

function cancelScheduleAndJob(tx: Database, deps: TimerDeps, timer: TimerRow) {
	if (timer.scheduleId) {
		const schedule = deps.scheduler.getInTransaction(tx, timer.scheduleId);
		if (schedule && (schedule.state === "active" || schedule.state === "paused"))
			deps.scheduler.cancelInTransaction(tx, schedule.id, schedule.revision);
	}
	if (timer.expiryJobId) {
		const job = deps.queue.getInTransaction(tx, timer.expiryJobId);
		if (job && isOpenJob(job.state))
			deps.queue.cancelInTransaction(tx, job.id, "timer_cancelled");
	}
}

function persistCancel(
	tx: Database,
	deps: TimerDeps,
	input: CancelTimerInput,
	issuedAtMs: number,
	inputDigest: string,
	scope: string,
	timerId: string,
	at: number,
	action: "cancelled" | "dismissed",
): SavedReceipt {
	const current = getTimer(tx, timerId);
	if (!current) throw new Error("timer_not_found");
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
		operation: "cancel",
		timerId,
		originKey: null,
		receipt,
		at,
	});
	return { receipt, replay: false };
}

function persistUnchanged(
	tx: Database,
	deps: TimerDeps,
	input: CancelTimerInput,
	issuedAtMs: number,
	inputDigest: string,
	scope: string,
	timer: TimerRow,
	at: number,
): SavedReceipt {
	const receipt: TimerReceipt = {
		kind: "timer_action",
		action: "unchanged",
		operationId: deps.id(),
		serverNow: iso(at),
		timer: toDto(timer, at),
	};
	if (countOperations(tx, scope) >= TIMER_POLICY.maxOperations)
		return { receipt, replay: false };
	saveOperation(tx, deps, {
		scope,
		requestId: input.requestId,
		issuedAtMs,
		inputDigest,
		operation: "cancel",
		timerId: timer.id,
		originKey: null,
		receipt,
		at,
	});
	return { receipt, replay: false };
}

export function getInTransaction(
	tx: Database,
	timerId: string,
	scope: string,
	nowMs: number,
) {
	const timer = getTimer(tx, timerId);
	if (!timer || timer.scope !== scope) return null;
	return toDto(timer, nowMs);
}

export type { StartTimerInput };
