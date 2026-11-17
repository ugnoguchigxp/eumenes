import type { Database } from "bun:sqlite";

/** Erases the retired research runs Dialogue named. A second call finds nothing left to erase. */
export function forgetPursuitReports(
	db: Database,
	runIds: readonly string[],
	now: number,
	forgetWeb: (id: string) => void,
	revokeNotice: (id: string) => void,
) {
	if (!runIds.length) return;
	const parents = db
		.query<{ id: string; core_id: string | null }, [string]>(
			`SELECT id, core_id FROM pursuit_runs
			WHERE data_json IS NOT NULL AND id IN (SELECT value FROM json_each(?))`,
		)
		.all(JSON.stringify(runIds));
	for (const parent of parents) {
		const cores = db
			.query<{ pursuit_id: string | null }, [string, string | null]>(
				"SELECT DISTINCT pursuit_id FROM pursuit_operation WHERE operation_key GLOB ? UNION SELECT ?",
			)
			.all(`pursuit:${parent.id}:*`, parent.core_id);
		for (const { pursuit_id: id } of cores) {
			if (!id) continue;
			db.query(
				`UPDATE pursuit_pursuit
				SET goal='', input_json='{}', action_plan_json=NULL, productive_json=NULL,
					status='stopped', current_strategy_id=NULL, current_hypothesis_id=NULL,
					forgotten_at=?, updated_at=?, finished_at=?, revision=revision+1
				WHERE id=? AND forgotten_at IS NULL`,
			).run(now, now, now, id);
			db.query(
				"UPDATE pursuit_operation SET digest='', forgotten_at=? WHERE pursuit_id=?",
			).run(now, id);
			for (const table of [
				"pursuit_progress",
				"pursuit_finding",
				"pursuit_report",
				"pursuit_verification",
				"pursuit_judgement",
				"pursuit_decision",
				"pursuit_consultation",
				"pursuit_inference",
				"pursuit_attempt",
				"pursuit_hypothesis",
				"pursuit_strategy",
				"pursuit_acceptance",
			])
				db.query(`DELETE FROM ${table} WHERE pursuit_id=?`).run(id);
		}
		const sources = db
			.query<{ external_id: string }, [string]>(
				"SELECT external_id FROM pursuit_web_operations WHERE run_id=?",
			)
			.all(parent.id);
		for (const { external_id } of sources) forgetWeb(external_id);
		const notices = db
			.query<{ id: string }, [string]>(
				"SELECT id FROM pursuit_notices WHERE run_id=?",
			)
			.all(parent.id);
		for (const notice of notices) revokeNotice(notice.id);
		for (const table of [
			"pursuit_documents",
			"pursuit_web_operations",
			"pursuit_notices",
		])
			db.query(`DELETE FROM ${table} WHERE run_id=?`).run(parent.id);
		db.query(
			`UPDATE pursuit_runs SET data_json=NULL, core_id=NULL, job_id=NULL,
			active_request=NULL, state='cancelled', revision=revision+1, updated_at=?
			WHERE id=?`,
		).run(now, parent.id);
	}
}
