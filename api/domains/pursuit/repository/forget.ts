import type { Database } from "bun:sqlite";

/** Erases retired research when the message that produced it is forgotten. */
export function forgetPursuitReports(
	db: Database,
	messageIds: readonly string[],
	now: number,
	forgetWeb: (id: string) => void,
	revokeNotice: (id: string) => void,
) {
	if (!messageIds.length) return;
	const parents = db
		.query<{ id: string; core_id: string | null }, [string]>(
			`SELECT DISTINCT p.id, p.core_id FROM pursuit_runs p
		JOIN dialogue_work w ON w.source_ref=p.id AND w.toolchain_id='web.research'
		WHERE p.data_json IS NOT NULL AND EXISTS (
			SELECT 1 FROM json_each(w.message_ids_json) m
			WHERE m.value IN (SELECT value FROM json_each(?))
		)`,
		)
		.all(JSON.stringify(messageIds));
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
