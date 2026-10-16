import type {
	NotificationReason,
	NotificationStatus,
	TimerState,
} from "../contracts";

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
	pausedAtMs: number | null;
	pausedRemainingMs: number | null;
	pausedTotalMs: number;
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
	operation: "start" | "list" | "cancel" | "pause" | "resume";
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

export type SqlTimer = Record<string, unknown>;

export function mapTimer(row: SqlTimer): TimerRow {
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
		pausedAtMs: (row.paused_at_ms as number | null) ?? null,
		pausedRemainingMs: (row.paused_remaining_ms as number | null) ?? null,
		pausedTotalMs: (row.paused_total_ms as number) ?? 0,
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

export function mapOperation(row: SqlTimer): OperationRow {
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

export function mapNotification(row: SqlTimer): NotificationRow {
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

export const changed = (result: { changes: number }) => result.changes === 1;
