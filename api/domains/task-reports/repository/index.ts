import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { TaskReport } from "../contracts";
export const migration = `
CREATE TABLE task_reports (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES work_tasks(id), sequence INTEGER NOT NULL, dedupe_key TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE(task_id,sequence), UNIQUE(task_id,dedupe_key));
CREATE TABLE task_report_outbox (report_id TEXT PRIMARY KEY REFERENCES task_reports(id), task_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','superseded','delivered')));
CREATE INDEX task_report_pending ON task_report_outbox(state,task_id);
`;
export function find(
	db: Database,
	taskId: string,
	key: string,
): TaskReport | null {
	const row = db
		.query(
			"SELECT data_json FROM task_reports WHERE task_id=? AND dedupe_key=?",
		)
		.get(taskId, key) as { data_json: string } | null;
	return row ? JSON.parse(row.data_json) : null;
}
export function append(
	db: Database,
	report: Omit<TaskReport, "sequence">,
): TaskReport {
	const row = db
		.query(
			"SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM task_reports WHERE task_id=?",
		)
		.get(report.taskId) as { seq: number };
	const value = { ...report, sequence: row.seq };
	if (new TextEncoder().encode(JSON.stringify(value)).length > 16384)
		throw new Error("invalid_task_report_size");
	db.query("INSERT INTO task_reports VALUES(?,?,?,?,?)").run(
		value.id,
		value.taskId,
		value.sequence,
		value.dedupeKey,
		JSON.stringify(value),
	);
	if (value.kind !== "monitoring_issue")
		db.query(
			"UPDATE task_report_outbox SET state='superseded' WHERE task_id=? AND state='pending' AND kind='progress'",
		).run(value.taskId);
	if (["completed", "failed", "cancelled", "paused"].includes(value.kind))
		db.query(
			"UPDATE task_report_outbox SET state='superseded' WHERE task_id=? AND state='pending' AND kind IN ('blocker','monitoring_issue')",
		).run(value.taskId);
	db.query("INSERT INTO task_report_outbox VALUES(?,?,?,'pending')").run(
		value.id,
		value.taskId,
		value.kind,
	);
	return value;
}
export function supersedeQuestions(db: Database, taskId: string) {
	db.query(
		"UPDATE task_report_outbox SET state='superseded' WHERE task_id=? AND kind='blocker' AND state='pending'",
	).run(taskId);
}
export function list(
	db: Database,
	taskId: string,
	after: number,
	limit: number,
): TaskReport[] {
	return (
		db
			.query(
				"SELECT data_json FROM task_reports WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?",
			)
			.all(taskId, after, limit) as { data_json: string }[]
	).map((r) => JSON.parse(r.data_json));
}
export function purge(db: Database, taskId: string) {
	db.query("DELETE FROM task_report_outbox WHERE task_id=?").run(taskId);
	db.query("DELETE FROM task_reports WHERE task_id=?").run(taskId);
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "task-reports/0001-init", sql: migration },
];

export function pending(db: Database, limit = 50): TaskReport[] {
	return (
		db
			.query(
				"SELECT r.data_json FROM task_report_outbox o JOIN task_reports r ON r.id=o.report_id WHERE o.state='pending' AND json_extract(r.data_json,'$.originConversationId') IS NOT NULL ORDER BY r.rowid LIMIT ?",
			)
			.all(limit) as { data_json: string }[]
	).map((r) => JSON.parse(r.data_json));
}
export function delivered(db: Database, id: string) {
	db.query(
		"UPDATE task_report_outbox SET state='delivered' WHERE report_id=? AND state='pending'",
	).run(id);
}
