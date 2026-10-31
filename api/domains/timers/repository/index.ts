import type { Database } from "bun:sqlite";
import type { TimerState } from "../contracts";
import {
	changed,
	mapOperation,
	mapTimer,
	type OperationRow,
	type SqlTimer,
	type TimerRow,
} from "./rows";
export { migrations } from "./migrations";
export type { NotificationRow, OperationRow, TimerRow } from "./rows";
export { countLive, markPaused, markResumed } from "./controls";
export {
	insertNotificationIfAbsent,
	getNotification,
	latestOpenNotification,
	undismissedCount,
	dismissNotifications,
	archiveNotifications,
	listNotifications,
	claimNotification,
	releaseClaim,
	settleNotification,
	silencePending,
	silenceClaimedStale,
	expiredClaims,
	stalePending,
} from "./notifications";

export function getTimer(db: Database, id: string): TimerRow | null {
	const row = db
		.query("SELECT * FROM timers WHERE id=?")
		.get(id) as SqlTimer | null;
	return row ? mapTimer(row) : null;
}

/** Bounded route hints: recent notices that the user can still dismiss. */
export function recentNotifiedTimers(
	db: Database,
	scope: string,
	limit: number,
): TimerRow[] {
	return (
		db
			.query(`SELECT t.* FROM timers t JOIN timer_notifications n ON n.timer_id=t.id
		WHERE t.scope=? AND t.state='elapsed' AND t.body_expired=0 AND n.status<>'dismissed'
		ORDER BY n.due_at_ms DESC, n.id DESC LIMIT ?`)
			.all(scope, limit) as SqlTimer[]
	).map(mapTimer);
}

export function getTimerByOrigin(
	db: Database,
	scope: string,
	originKey: string,
): TimerRow | null {
	const row = db
		.query("SELECT * FROM timers WHERE scope=? AND origin_key=?")
		.get(scope, originKey) as SqlTimer | null;
	return row ? mapTimer(row) : null;
}

export function countActive(db: Database, scope: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM timers WHERE scope=? AND state='active' AND body_expired=0",
			)
			.get(scope) as { n: number }
	).n;
}

export { countTimers, countOperations, countListOperations } from "./counts";
export {
	markDispatchExhausted,
	pruneBatch,
	deleteExpiredListOperations,
} from "./retention";

export function insertTimer(
	db: Database,
	row: {
		id: string;
		scope: string;
		conversationId: string | null;
		originRunId: string | null;
		originMessageId: string | null;
		originKey: string | null;
		label: string;
		durationSeconds: number;
		startedAtMs: number;
		dueAtMs: number;
		createdAtMs: number;
	},
): TimerRow {
	db.query(
		`INSERT INTO timers (
      id, scope, conversation_id, origin_run_id, origin_message_id, origin_key,
      label, duration_seconds, started_at_ms, due_at_ms, state, revision, cancel_epoch,
      dispatch_generation, body_expired, created_at_ms, updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,'active',0,0,0,0,?,?)`,
	).run(
		row.id,
		row.scope,
		row.conversationId,
		row.originRunId,
		row.originMessageId,
		row.originKey,
		row.label,
		row.durationSeconds,
		row.startedAtMs,
		row.dueAtMs,
		row.createdAtMs,
		row.createdAtMs,
	);
	return getTimer(db, row.id)!;
}

export function attachSchedule(
	db: Database,
	id: string,
	scheduleId: string,
): boolean {
	return changed(
		db
			.query(
				"UPDATE timers SET schedule_id=? WHERE id=? AND schedule_id IS NULL",
			)
			.run(scheduleId, id),
	);
}

export function attachExpiryJob(
	db: Database,
	id: string,
	jobId: string,
	expectedGeneration: number,
	nextGeneration: number,
): boolean {
	return changed(
		db
			.query(
				"UPDATE timers SET expiry_job_id=?, dispatch_generation=? WHERE id=? AND dispatch_generation=?",
			)
			.run(jobId, nextGeneration, id, expectedGeneration),
	);
}

export function markCancelled(
	db: Database,
	id: string,
	scope: string,
	expectedRevision: number,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timers SET state='cancelled', paused_at_ms=NULL, cancelled_at_ms=?, terminal_at_ms=?,
         revision=revision+1, cancel_epoch=cancel_epoch+1, updated_at_ms=?
				WHERE id=? AND scope=? AND state IN ('active','paused') AND revision=?`,
			)
			.run(at, at, at, id, scope, expectedRevision),
	);
}

export function bumpEpoch(
	db: Database,
	id: string,
	scope: string,
	expectedRevision: number,
	expectedState: TimerState,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timers SET revision=revision+1, cancel_epoch=cancel_epoch+1, updated_at_ms=?
         WHERE id=? AND scope=? AND state=? AND revision=?`,
			)
			.run(at, id, scope, expectedState, expectedRevision),
	);
}

export function markElapsed(
	db: Database,
	id: string,
	cancelEpoch: number,
	dispatchGeneration: number,
	dueAtMs: number,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timers SET state='elapsed', terminal_at_ms=?, revision=revision+1,
         error_code=NULL, updated_at_ms=?
         WHERE id=? AND state='active' AND cancel_epoch=? AND dispatch_generation=? AND due_at_ms<=?`,
			)
			.run(at, at, id, cancelEpoch, dispatchGeneration, dueAtMs),
	);
}

export function setTimerError(
	db: Database,
	id: string,
	errorCode: string,
	at: number,
): boolean {
	return changed(
		db
			.query(
				"UPDATE timers SET error_code=?, updated_at_ms=? WHERE id=? AND state='active'",
			)
			.run(errorCode, at, id),
	);
}

export function getOperation(db: Database, id: string): OperationRow | null {
	const row = db
		.query("SELECT * FROM timer_operations WHERE id=?")
		.get(id) as SqlTimer | null;
	return row ? mapOperation(row) : null;
}

export function getOperationByRequest(
	db: Database,
	scope: string,
	requestId: string,
): OperationRow | null {
	const row = db
		.query("SELECT * FROM timer_operations WHERE scope=? AND request_id=?")
		.get(scope, requestId) as SqlTimer | null;
	return row ? mapOperation(row) : null;
}

export function getStartReceiptByOrigin(
	db: Database,
	scope: string,
	originKey: string,
): OperationRow | null {
	const row = db
		.query(
			`SELECT * FROM timer_operations
       WHERE scope=? AND origin_key=? AND operation='start'
       ORDER BY created_at_ms ASC LIMIT 1`,
		)
		.get(scope, originKey) as SqlTimer | null;
	return row ? mapOperation(row) : null;
}

export function getStartedReceiptByRun(
	db: Database,
	scope: string,
	runId: string,
): OperationRow | null {
	const row = db
		.query(
			`SELECT o.* FROM timer_operations o
       JOIN timers t ON t.id=o.timer_id
       WHERE o.scope=? AND t.scope=? AND t.origin_run_id=? AND o.operation='start'
         AND o.receipt_json IS NOT NULL
       ORDER BY o.created_at_ms ASC LIMIT 1`,
		)
		.get(scope, scope, runId) as SqlTimer | null;
	return row ? mapOperation(row) : null;
}

export function insertOperation(
	db: Database,
	row: {
		id: string;
		scope: string;
		requestId: string;
		issuedAtMs: number;
		inputDigest: string;
		operation: OperationRow["operation"];
		timerId: string | null;
		originKey: string | null;
		receiptJson: string;
		receiptDigest: string;
		createdAtMs: number;
	},
): void {
	db.query(
		`INSERT INTO timer_operations (
      id, scope, request_id, issued_at_ms, input_digest, operation, timer_id, origin_key,
      receipt_json, receipt_digest, created_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		row.id,
		row.scope,
		row.requestId,
		row.issuedAtMs,
		row.inputDigest,
		row.operation,
		row.timerId,
		row.originKey,
		row.receiptJson,
		row.receiptDigest,
		row.createdAtMs,
	);
}

export type TimerListFilter = {
	scope: string;
	state?: TimerState | null;
	conversationId?: string | null;
	timerId?: string | null;
	cursorCreatedAtMs?: number | null;
	cursorId?: string | null;
	limit: number;
};

export function listTimers(db: Database, filter: TimerListFilter): TimerRow[] {
	const rows = db
		.query(
			`SELECT * FROM timers
       WHERE scope=?
         AND (? IS NULL OR state=?)
         AND (? IS NULL OR conversation_id=?)
         AND (? IS NULL OR id=?)
         AND (
           ? IS NULL OR created_at_ms < ? OR (created_at_ms = ? AND id < ?)
         )
       ORDER BY created_at_ms DESC, id DESC
       LIMIT ?`,
		)
		.all(
			filter.scope,
			filter.state ?? null,
			filter.state ?? null,
			filter.conversationId ?? null,
			filter.conversationId ?? null,
			filter.timerId ?? null,
			filter.timerId ?? null,
			filter.cursorCreatedAtMs ?? null,
			filter.cursorCreatedAtMs ?? null,
			filter.cursorCreatedAtMs ?? null,
			filter.cursorId ?? null,
			filter.limit,
		) as SqlTimer[];
	return rows.map(mapTimer);
}

export function findDueActive(
	db: Database,
	now: number,
	limit: number,
): TimerRow[] {
	const rows = db
		.query(
			`SELECT * FROM timers WHERE state='active' AND due_at_ms<=?
       ORDER BY due_at_ms ASC, id ASC LIMIT ?`,
		)
		.all(now, limit) as SqlTimer[];
	return rows.map(mapTimer);
}
