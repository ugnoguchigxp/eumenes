import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type {
	NotificationReason,
	NotificationStatus,
	TimerState,
} from "../contracts";

export const migration = `
CREATE TABLE timers (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  conversation_id TEXT,
  origin_run_id TEXT,
  origin_message_id TEXT,
  origin_key TEXT,
  label TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 86400),
  started_at_ms INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  cancelled_at_ms INTEGER,
  terminal_at_ms INTEGER,
  state TEXT NOT NULL CHECK(state IN ('active','elapsed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 0,
  cancel_epoch INTEGER NOT NULL DEFAULT 0,
  schedule_id TEXT,
  expiry_job_id TEXT,
  dispatch_generation INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  body_expired INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(due_at_ms = started_at_ms + duration_seconds * 1000),
  CHECK((state = 'cancelled') = (cancelled_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX timers_origin ON timers(scope, origin_key)
  WHERE origin_key IS NOT NULL;
CREATE INDEX timers_due ON timers(state, due_at_ms, id);
CREATE INDEX timers_conversation ON timers(scope, conversation_id, created_at_ms, id);

CREATE TABLE timer_operations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('start','list','cancel')),
  timer_id TEXT,
  origin_key TEXT,
  receipt_json TEXT,
  receipt_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expired_at_ms INTEGER,
  UNIQUE(scope, request_id)
);

CREATE TABLE timer_notifications (
  id TEXT PRIMARY KEY,
  timer_id TEXT NOT NULL REFERENCES timers(id),
  scope TEXT NOT NULL,
  generation INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','played','silent','dismissed')),
  reason TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claim_request_id TEXT,
  client_id TEXT,
  lease_until_ms INTEGER,
  played_at_ms INTEGER,
  dismissed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(timer_id, generation)
);
CREATE INDEX timer_notifications_pending
  ON timer_notifications(scope, status, due_at_ms, id);
`;

export type TimerRow = {
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
	cancelledAtMs: number | null;
	terminalAtMs: number | null;
	state: TimerState;
	revision: number;
	cancelEpoch: number;
	scheduleId: string | null;
	expiryJobId: string | null;
	dispatchGeneration: number;
	errorCode: string | null;
	bodyExpired: boolean;
	createdAtMs: number;
	updatedAtMs: number;
};

export type OperationRow = {
	id: string;
	scope: string;
	requestId: string;
	issuedAtMs: number;
	inputDigest: string;
	operation: "start" | "list" | "cancel";
	timerId: string | null;
	originKey: string | null;
	receiptJson: string | null;
	receiptDigest: string;
	createdAtMs: number;
	expiredAtMs: number | null;
};

export type NotificationRow = {
	id: string;
	timerId: string;
	scope: string;
	generation: number;
	dueAtMs: number;
	status: NotificationStatus;
	reason: NotificationReason | null;
	revision: number;
	claimId: string | null;
	claimRequestId: string | null;
	clientId: string | null;
	leaseUntilMs: number | null;
	playedAtMs: number | null;
	dismissedAtMs: number | null;
	createdAtMs: number;
	updatedAtMs: number;
};

type SqlTimer = Record<string, unknown>;

function mapTimer(row: SqlTimer): TimerRow {
	return {
		id: row.id as string,
		scope: row.scope as string,
		conversationId: (row.conversation_id as string | null) ?? null,
		originRunId: (row.origin_run_id as string | null) ?? null,
		originMessageId: (row.origin_message_id as string | null) ?? null,
		originKey: (row.origin_key as string | null) ?? null,
		label: row.label as string,
		durationSeconds: row.duration_seconds as number,
		startedAtMs: row.started_at_ms as number,
		dueAtMs: row.due_at_ms as number,
		cancelledAtMs: (row.cancelled_at_ms as number | null) ?? null,
		terminalAtMs: (row.terminal_at_ms as number | null) ?? null,
		state: row.state as TimerState,
		revision: row.revision as number,
		cancelEpoch: row.cancel_epoch as number,
		scheduleId: (row.schedule_id as string | null) ?? null,
		expiryJobId: (row.expiry_job_id as string | null) ?? null,
		dispatchGeneration: row.dispatch_generation as number,
		errorCode: (row.error_code as string | null) ?? null,
		bodyExpired: row.body_expired === 1,
		createdAtMs: row.created_at_ms as number,
		updatedAtMs: row.updated_at_ms as number,
	};
}

function mapOperation(row: SqlTimer): OperationRow {
	return {
		id: row.id as string,
		scope: row.scope as string,
		requestId: row.request_id as string,
		issuedAtMs: row.issued_at_ms as number,
		inputDigest: row.input_digest as string,
		operation: row.operation as OperationRow["operation"],
		timerId: (row.timer_id as string | null) ?? null,
		originKey: (row.origin_key as string | null) ?? null,
		receiptJson: (row.receipt_json as string | null) ?? null,
		receiptDigest: row.receipt_digest as string,
		createdAtMs: row.created_at_ms as number,
		expiredAtMs: (row.expired_at_ms as number | null) ?? null,
	};
}

function mapNotification(row: SqlTimer): NotificationRow {
	return {
		id: row.id as string,
		timerId: row.timer_id as string,
		scope: row.scope as string,
		generation: row.generation as number,
		dueAtMs: row.due_at_ms as number,
		status: row.status as NotificationStatus,
		reason: (row.reason as NotificationReason | null) ?? null,
		revision: row.revision as number,
		claimId: (row.claim_id as string | null) ?? null,
		claimRequestId: (row.claim_request_id as string | null) ?? null,
		clientId: (row.client_id as string | null) ?? null,
		leaseUntilMs: (row.lease_until_ms as number | null) ?? null,
		playedAtMs: (row.played_at_ms as number | null) ?? null,
		dismissedAtMs: (row.dismissed_at_ms as number | null) ?? null,
		createdAtMs: row.created_at_ms as number,
		updatedAtMs: row.updated_at_ms as number,
	};
}

const changed = (result: { changes: number }) => result.changes === 1;

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
				`UPDATE timers SET state='cancelled', cancelled_at_ms=?, terminal_at_ms=?,
         revision=revision+1, cancel_epoch=cancel_epoch+1, updated_at_ms=?
         WHERE id=? AND scope=? AND state='active' AND revision=?`,
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
		operation: "start" | "list" | "cancel";
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

export function insertNotificationIfAbsent(
	db: Database,
	row: {
		id: string;
		timerId: string;
		scope: string;
		generation: number;
		dueAtMs: number;
		status: "pending" | "silent";
		reason: NotificationReason | null;
		at: number;
	},
): boolean {
	const result = db
		.query(
			`INSERT INTO timer_notifications (
        id, timer_id, scope, generation, due_at_ms, status, reason, revision,
        created_at_ms, updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,0,?,?)
      ON CONFLICT(timer_id, generation) DO NOTHING`,
		)
		.run(
			row.id,
			row.timerId,
			row.scope,
			row.generation,
			row.dueAtMs,
			row.status,
			row.reason,
			row.at,
			row.at,
		);
	return result.changes === 1;
}

export function getNotification(
	db: Database,
	id: string,
): NotificationRow | null {
	const row = db
		.query("SELECT * FROM timer_notifications WHERE id=?")
		.get(id) as SqlTimer | null;
	return row ? mapNotification(row) : null;
}

export function latestOpenNotification(
	db: Database,
	timerId: string,
): NotificationRow | null {
	const row = db
		.query(
			`SELECT * FROM timer_notifications
       WHERE timer_id=? AND status!='dismissed'
       ORDER BY generation DESC, id DESC LIMIT 1`,
		)
		.get(timerId) as SqlTimer | null;
	return row ? mapNotification(row) : null;
}

export function undismissedCount(db: Database, timerId: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM timer_notifications WHERE timer_id=? AND status!='dismissed'",
			)
			.get(timerId) as { n: number }
	).n;
}

export function dismissNotifications(
	db: Database,
	timerId: string,
	at: number,
): number {
	return db
		.query(
			`UPDATE timer_notifications
       SET status='dismissed', dismissed_at_ms=?, claim_id=NULL, lease_until_ms=NULL,
           revision=revision+1, updated_at_ms=?
       WHERE timer_id=? AND status!='dismissed'`,
		)
		.run(at, at, timerId).changes;
}

export function listNotifications(
	db: Database,
	scope: string,
	cursorDue: number | null,
	cursorId: string | null,
	limit: number,
): NotificationRow[] {
	const rows = db
		.query(
			`SELECT * FROM timer_notifications
       WHERE scope=? AND status!='dismissed'
         AND (? IS NULL OR due_at_ms > ? OR (due_at_ms = ? AND id > ?))
       ORDER BY due_at_ms ASC, id ASC
       LIMIT ?`,
		)
		.all(scope, cursorDue, cursorDue, cursorDue, cursorId, limit) as SqlTimer[];
	return rows.map(mapNotification);
}

export function claimNotification(
	db: Database,
	id: string,
	scope: string,
	expectedRevision: number,
	claimId: string,
	claimRequestId: string,
	clientId: string,
	leaseUntilMs: number,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status='claimed', reason=NULL, revision=revision+1,
             claim_id=?, claim_request_id=?, client_id=?, lease_until_ms=?, updated_at_ms=?
         WHERE id=? AND scope=? AND status='pending' AND revision=?`,
			)
			.run(
				claimId,
				claimRequestId,
				clientId,
				leaseUntilMs,
				at,
				id,
				scope,
				expectedRevision,
			),
	);
}

export function releaseClaim(db: Database, id: string, at: number): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status='pending', claim_id=NULL, claim_request_id=NULL, client_id=NULL,
             lease_until_ms=NULL, revision=revision+1, updated_at_ms=?
         WHERE id=? AND status='claimed'`,
			)
			.run(at, id),
	);
}

export function settleNotification(
	db: Database,
	id: string,
	scope: string,
	claimId: string,
	clientId: string,
	status: "played" | "silent",
	reason: NotificationReason | null,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status=?, reason=?, played_at_ms=CASE WHEN ?='played' THEN ? ELSE played_at_ms END,
             revision=revision+1, updated_at_ms=?
         WHERE id=? AND scope=? AND status='claimed' AND claim_id=? AND client_id=?
           AND lease_until_ms IS NOT NULL AND lease_until_ms>?`,
			)
			.run(status, reason, status, at, at, id, scope, claimId, clientId, at),
	);
}

export function silencePending(
	db: Database,
	id: string,
	scope: string,
	expectedRevision: number,
	reason: "muted" | "blocked" | "stale",
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status='silent', reason=?, revision=revision+1, updated_at_ms=?
         WHERE id=? AND scope=? AND status='pending' AND revision=?`,
			)
			.run(reason, at, id, scope, expectedRevision),
	);
}

export function silenceClaimedStale(
	db: Database,
	id: string,
	at: number,
): boolean {
	return changed(
		db
			.query(
				`UPDATE timer_notifications
         SET status='silent', reason='stale', claim_id=NULL, claim_request_id=NULL,
             client_id=NULL, lease_until_ms=NULL, revision=revision+1, updated_at_ms=?
         WHERE id=? AND status='claimed'`,
			)
			.run(at, id),
	);
}

export function expiredClaims(db: Database, now: number, limit: number) {
	const rows = db
		.query(
			`SELECT * FROM timer_notifications
       WHERE status='claimed' AND lease_until_ms IS NOT NULL AND lease_until_ms<=?
       ORDER BY lease_until_ms ASC, id ASC LIMIT ?`,
		)
		.all(now, limit) as SqlTimer[];
	return rows.map(mapNotification);
}

export function stalePending(
	db: Database,
	now: number,
	freshMs: number,
	limit: number,
) {
	const rows = db
		.query(
			`SELECT * FROM timer_notifications
       WHERE status='pending' AND ? - due_at_ms > ?
       ORDER BY due_at_ms ASC, id ASC LIMIT ?`,
		)
		.all(now, freshMs, limit) as SqlTimer[];
	return rows.map(mapNotification);
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "timers/0001-init", sql: migration },
	{
		id: "timers/0002-retention-indexes",
		after: ["timers/0001-init"],
		sql: `
CREATE INDEX timer_operations_live ON timer_operations(created_at_ms, id) WHERE receipt_json IS NOT NULL;
CREATE INDEX timer_operations_expired ON timer_operations(expired_at_ms, id) WHERE expired_at_ms IS NOT NULL;
CREATE INDEX timer_operations_timer ON timer_operations(timer_id) WHERE timer_id IS NOT NULL;
CREATE INDEX timer_operations_scope_kind ON timer_operations(scope, operation);
CREATE INDEX timers_retention ON timers(body_expired, updated_at_ms, id) WHERE state!='active';
`,
	},
];
