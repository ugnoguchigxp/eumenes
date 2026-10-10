import type { TimerDto } from "../contracts";
import type { TimerRow } from "../repository";
import { iso } from "./canonical";

/** Remaining time is derived from the deadline, never by subtracting one each tick. */
function remainingSeconds(row: TimerRow, nowMs: number): number {
	if (row.state === "elapsed") return 0;
	const basis =
		row.state === "cancelled" ? (row.cancelledAtMs ?? nowMs) : nowMs;
	return Math.max(0, Math.ceil((row.dueAtMs - basis) / 1000));
}

export function toDto(row: TimerRow, nowMs: number): TimerDto {
	return {
		id: row.id,
		revision: row.revision,
		state: row.state,
		label: row.label,
		durationSeconds: row.durationSeconds,
		startedAt: iso(row.startedAtMs),
		dueAt: iso(row.dueAtMs),
		cancelledAt: row.cancelledAtMs === null ? null : iso(row.cancelledAtMs),
		remainingSeconds: remainingSeconds(row, nowMs),
		conversationId: row.conversationId,
		originRunId: row.originRunId,
		originMessageId: row.originMessageId,
		errorCode: row.errorCode,
		bodyExpired: row.bodyExpired,
	};
}
