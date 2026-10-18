import { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import { get } from "../repository";

/** Diagnostic read of the exact accepted child → parent payload, not a regenerated answer. */
export function reportProjectionInTransaction(db: Database, id: string) {
	const task = get(db, id);
	if (!task) throw new Error("task_not_found");
	const target = task.report_task_id ? get(db, task.report_task_id) : task;
	if (!target || ["deleted", "expired"].includes(target.report_state))
		throw new Error("report_deleted");
	if (
		!["completed", "ready_for_answer"].includes(task.state) ||
		!["completed", "ready_for_answer"].includes(target.state) ||
		target.report_state !== "available"
	)
		throw new Error("report_not_ready");
	const row = db
		.query(
			"SELECT report_digest,safe_projection_json,safe_projection_digest FROM agent_reports WHERE task_id=?",
		)
		.get(target.id) as {
		report_digest: string;
		safe_projection_json: string | null;
		safe_projection_digest: string | null;
	} | null;
	if (!row) throw new Error("report_deleted");
	if (!row.safe_projection_json) return null;
	if (hash(JSON.parse(row.safe_projection_json)) !== row.safe_projection_digest)
		throw new Error("report_invalidated");
	return {
		taskId: target.id,
		rootRunId: target.root_run_id,
		reportDigest: row.report_digest,
		projectionDigest: row.safe_projection_digest,
		projection: row.safe_projection_json,
	};
}

/** Backend evaluation only: no writer, migrations, lifecycle or model calls. */
export function readStoredReportProjection(dbPath: string, taskId: string) {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.transaction(() => reportProjectionInTransaction(db, taskId))();
	} finally {
		db.close();
	}
}
