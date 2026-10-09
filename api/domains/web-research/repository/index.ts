import type { Database } from "bun:sqlite";
import type { ResearchRequest, ResearchState } from "../contracts";

export const migration = `
CREATE TABLE web_research_runs (
	id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
	input_json TEXT NOT NULL, job_id TEXT NOT NULL, operation TEXT NOT NULL,
	status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, error_code TEXT
);
CREATE INDEX web_research_runs_expiry ON web_research_runs(finished_at_ms);
`;
/** Host-set per-attempt timeout (ms), counted from execute start. Appended migration. */
export const attemptTimeoutMigration = `
ALTER TABLE web_research_runs ADD COLUMN attempt_timeout_ms INTEGER;
`;
export interface RunRow {
	id: string;
	request_id: string;
	input_digest: string;
	input_json: string;
	job_id: string;
	operation: ResearchRequest["operation"];
	status: ResearchState;
	created_at_ms: number;
	finished_at_ms: number | null;
	error_code: string | null;
	/** Absent before attemptTimeoutMigration is applied. */
	attempt_timeout_ms?: number | null;
}
export const byId = (db: Database, id: string) =>
	db
		.query<RunRow, [string]>("SELECT * FROM web_research_runs WHERE id=?")
		.get(id);
export const byRequest = (db: Database, id: string) =>
	db
		.query<RunRow, [string]>(
			"SELECT * FROM web_research_runs WHERE request_id=?",
		)
		.get(id);
export function insert(
	db: Database,
	id: string,
	request: ResearchRequest,
	digest: string,
	jobId: string,
	now: number,
	attemptTimeoutMs?: number,
) {
	const base = [
		id,
		request.requestId,
		digest,
		JSON.stringify(request),
		jobId,
		request.operation,
		now,
	];
	// Explicit column lists keep older schemas (without the appended column) working.
	if (attemptTimeoutMs === undefined)
		db.query(
			"INSERT INTO web_research_runs(id,request_id,input_digest,input_json,job_id,operation,status,created_at_ms) VALUES (?,?,?,?,?,?,'queued',?)",
		).run(...base);
	else
		db.query(
			"INSERT INTO web_research_runs(id,request_id,input_digest,input_json,job_id,operation,status,created_at_ms,attempt_timeout_ms) VALUES (?,?,?,?,?,?,'queued',?,?)",
		).run(...base, attemptTimeoutMs);
}
export function finish(
	db: Database,
	id: string,
	state: ResearchState,
	now: number,
	code: string | null = null,
) {
	return (
		db
			.query(
				"UPDATE web_research_runs SET status=?, finished_at_ms=?, error_code=? WHERE id=? AND status IN ('queued','running') RETURNING id",
			)
			.get(state, now, code, id) !== null
	);
}
export function running(db: Database, id: string) {
	return (
		db
			.query(
				"UPDATE web_research_runs SET status='running' WHERE id=? AND status='queued' RETURNING id",
			)
			.get(id) !== null
	);
}
export function sweepRuns(db: Database, now: number) {
	// Scrub finished input after 14 days; keep metadata for 30 days.
	db.query(
		"UPDATE web_research_runs SET input_json='{}' WHERE id IN (SELECT id FROM web_research_runs WHERE finished_at_ms IS NOT NULL AND finished_at_ms<=? AND input_json!='{}' LIMIT 100)",
	).run(now - 14 * 86400000);
	db.query(
		"DELETE FROM web_research_runs WHERE id IN (SELECT id FROM web_research_runs WHERE finished_at_ms<=? LIMIT 100)",
	).run(now - 30 * 86400000);
}
