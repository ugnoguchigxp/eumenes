import type { Database } from "bun:sqlite";
import type { StepId, UnitSlot } from "../contracts";

/** An open unit that has its job: whether it runs now is the queue's state of that job. */
export function openUnitJobs(
	db: Database,
	conversationId: string,
): { slot: UnitSlot; jobId: string }[] {
	return db
		.query(
			"SELECT slot, job_id AS jobId FROM steward_unit WHERE conversation_id = ? AND state = 'open' AND job_id IS NOT NULL",
		)
		.all(conversationId) as { slot: UnitSlot; jobId: string }[];
}

export interface ClosedUnitRow {
	slot: UnitSlot;
	step: StepId;
	state: "applied" | "stale" | "failed";
	attempt: number;
	jobId: string | null;
	closedAt: string;
	/** The error code of the unit's decision (the last one its job wrote); null when it wrote none or succeeded. */
	errorCode: string | null;
}

/** Whether the unit's job recorded one of `codes` (SQL over the unit alias `x`). */
const recorded = (codes: readonly string[]) =>
	codes.length
		? `EXISTS (SELECT 1 FROM steward_decision d WHERE d.conversation_id = x.conversation_id AND d.job_id = x.job_id
			AND d.error_code IN (${codes.map(() => "?").join(",")}))`
		: "0";

/**
 * Per slot, the unit that closed last in the conversation, with the error code its job recorded. Units whose job
 * recorded one of `skipCodes` (a yield the steward retries by itself) are passed over, so they never hide the
 * failure before them. A failure is left out once the same step later succeeded without a unit (World events
 * routed with nothing to record write only a decision).
 */
export function lastClosedUnits(
	db: Database,
	conversationId: string,
	skipCodes: readonly string[],
): ClosedUnitRow[] {
	return db
		.query(
			`SELECT u.slot, u.step, u.state, u.attempt, u.job_id AS jobId, u.closed_at AS closedAt,
				(SELECT d.error_code FROM steward_decision d
					WHERE d.conversation_id = u.conversation_id AND d.job_id = u.job_id
					ORDER BY d.id DESC LIMIT 1) AS errorCode
			FROM steward_unit u
			WHERE u.conversation_id = ? AND u.state <> 'open' AND u.closed_at IS NOT NULL
				AND u.id = (SELECT x.id FROM steward_unit x
					WHERE x.conversation_id = u.conversation_id AND x.slot = u.slot
						AND x.state <> 'open' AND x.closed_at IS NOT NULL AND NOT ${recorded(skipCodes)}
					ORDER BY x.closed_at DESC, x.rowid DESC LIMIT 1)
				AND NOT (u.state = 'failed' AND EXISTS (SELECT 1 FROM steward_decision s
					WHERE s.conversation_id = u.conversation_id AND s.step = u.step AND s.job_id IS NOT u.job_id
						AND s.error_code IS NULL AND s.created_at > u.closed_at))`,
		)
		.all(conversationId, ...skipCodes) as ClosedUnitRow[];
}

/** The failed units of one step in the conversation that closed at or after `sinceIso`, `skipCodes` left out. */
export function countFailedUnits(
	db: Database,
	conversationId: string,
	step: StepId,
	sinceIso: string,
	skipCodes: readonly string[],
): number {
	const row = db
		.query(
			`SELECT COUNT(*) AS n FROM steward_unit x WHERE x.conversation_id = ? AND x.step = ? AND x.state = 'failed'
				AND x.closed_at >= ? AND NOT ${recorded(skipCodes)}`,
		)
		.get(conversationId, step, sinceIso, ...skipCodes) as { n: number };
	return row.n;
}
