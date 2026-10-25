import type { Database } from "bun:sqlite";

/** A stored research report with the request its task was given (read-only; the writers live with the answer flow). */
export type StoredReportRow = {
	task_id: string;
	report_json: string;
	safe_projection_json: string | null;
	created_at: number;
	input_json: string | null;
};

const COLUMNS =
	"r.task_id, r.report_json, r.safe_projection_json, r.created_at, t.input_json";
/** Only reports whose task still holds them (deleted and expired ones are gone for every reader). */
const FROM =
	"FROM agent_reports r JOIN agent_tasks t ON t.id = r.task_id WHERE t.report_state = 'available'";

export const storedReportById = (db: Database, taskId: string) =>
	db
		.query(`SELECT ${COLUMNS} ${FROM} AND r.task_id = ?`)
		.get(taskId) as StoredReportRow | null;

/** The reports whose summary is exactly `summary` (the lookup key of a finished TODO's result). */
export const storedReportsBySummary = (db: Database, summary: string) =>
	db
		.query(
			`SELECT ${COLUMNS} ${FROM} AND json_extract(r.report_json, '$.summary') = ? ORDER BY r.created_at DESC`,
		)
		.all(summary) as StoredReportRow[];

/** Newest first within `[sinceMs, untilMs]`, at most `limit` rows. */
export const storedReportsNewest = (
	db: Database,
	range: { sinceMs?: number; untilMs?: number },
	limit: number,
) =>
	db
		.query(
			`SELECT ${COLUMNS} ${FROM} AND r.created_at >= ? AND r.created_at <= ? ORDER BY r.created_at DESC, r.task_id LIMIT ?`,
		)
		.all(
			range.sinceMs ?? Number.MIN_SAFE_INTEGER,
			range.untilMs ?? Number.MAX_SAFE_INTEGER,
			limit,
		) as StoredReportRow[];
