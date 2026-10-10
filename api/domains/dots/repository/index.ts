import { storageMigration } from "./storage";
import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Command, Connection, Project, DotReport } from "../contracts";

export const migration = `
CREATE TABLE dots_dialogue_receipts(run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, task_id TEXT NOT NULL, receipt_json TEXT NOT NULL);
CREATE TABLE dots_connections (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, local_token_hash TEXT NOT NULL);
CREATE TABLE dots_projects (ref TEXT PRIMARY KEY, connection_ref TEXT NOT NULL REFERENCES dots_connections(id), data_json TEXT NOT NULL);
CREATE TABLE dots_commands (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, connection_ref TEXT NOT NULL REFERENCES dots_connections(id), state TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE INDEX dots_commands_pending ON dots_commands(connection_ref,state,seq);
CREATE INDEX dots_commands_task ON dots_commands(task_id,seq);
CREATE TABLE dots_reports (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_sequence INTEGER NOT NULL, digest TEXT NOT NULL, data_json TEXT NOT NULL, receipt_json TEXT NOT NULL, UNIQUE(task_id,source_sequence));
CREATE TABLE dots_sessions (thread_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE dots_schedules (ref TEXT PRIMARY KEY, connection_ref TEXT NOT NULL REFERENCES dots_connections(id), task_id TEXT NOT NULL, command_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE dots_reminders (schedule_ref TEXT NOT NULL REFERENCES dots_schedules(ref), occurrence_ref TEXT NOT NULL, report_id TEXT NOT NULL, PRIMARY KEY(schedule_ref,occurrence_ref));
CREATE TABLE dots_subscriptions (connection_ref TEXT PRIMARY KEY REFERENCES dots_connections(id), data_json TEXT NOT NULL);
CREATE TABLE dots_deliveries (id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE REFERENCES dots_commands(id), data_json TEXT NOT NULL);
`;
export const migrations: readonly Migration[] = [
	{
		id: "dots/0001-init",
		after: ["tasks/0002-retention"],
		sql: migration + storageMigration,
	},
	{
		id: "dots/0002-session-associations",
		after: ["dots/0001-init"],
		sql: `ALTER TABLE dots_sessions RENAME TO dots_sessions_v1;
CREATE TABLE dots_sessions(thread_id TEXT NOT NULL,task_id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(task_id,thread_id));
INSERT INTO dots_sessions SELECT thread_id,task_id,data_json FROM dots_sessions_v1;
DROP TABLE dots_sessions_v1;
CREATE INDEX dots_sessions_thread ON dots_sessions(thread_id);`,
	},
];
function read<T>(db: Database, sql: string, ...args: string[]): T | null {
	const row = db.query(sql).get(...args) as { data_json: string } | null;
	return row ? JSON.parse(row.data_json) : null;
}
export const connection = (db: Database, id: string) =>
	read<Connection>(db, "SELECT data_json FROM dots_connections WHERE id=?", id);
export const project = (db: Database, id: string) =>
	read<Project>(db, "SELECT data_json FROM dots_projects WHERE ref=?", id);
export const command = (db: Database, id: string) =>
	read<Command>(db, "SELECT data_json FROM dots_commands WHERE id=?", id);
export function commands(
	db: Database,
	connectionRef: string,
	after = 0,
	limit = 50,
) {
	return (
		db
			.query(
				"SELECT seq,data_json FROM dots_commands WHERE connection_ref=? AND seq>? AND state IN ('pending','claimed') ORDER BY seq LIMIT ?",
			)
			.all(connectionRef, after, limit) as { seq: number; data_json: string }[]
	).map((r) => ({ seq: r.seq, command: JSON.parse(r.data_json) as Command }));
}
export function putCommand(db: Database, c: Command) {
	db.query(
		"INSERT INTO dots_commands(id,task_id,connection_ref,state,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data_json=excluded.data_json",
	).run(c.commandId, c.taskId, c.connectionRef, c.state, JSON.stringify(c));
}
export function taskCommands(db: Database, id: string): Command[] {
	return (
		db
			.query("SELECT data_json FROM dots_commands WHERE task_id=? ORDER BY seq")
			.all(id) as { data_json: string }[]
	).map((r) => JSON.parse(r.data_json));
}
export function report(db: Database, id: string) {
	return db
		.query("SELECT digest,receipt_json,task_id FROM dots_reports WHERE id=?")
		.get(id) as {
		digest: string;
		receipt_json: string;
		task_id: string;
	} | null;
}
export const lastSequence = (db: Database, id: string) =>
	(
		db
			.query(
				"SELECT coalesce(max(source_sequence),0) AS n FROM dots_reports WHERE task_id=?",
			)
			.get(id) as { n: number }
	).n;
export function saveReport(
	db: Database,
	r: DotReport,
	digest: string,
	receipt: unknown,
) {
	db.query("INSERT INTO dots_reports VALUES(?,?,?,?,?,?)").run(
		r.reportId,
		r.taskId,
		r.sourceSequence,
		digest,
		JSON.stringify(r),
		JSON.stringify(receipt),
	);
}
export function purge(db: Database, id: string) {
	db.query(
		"DELETE FROM dots_reminders WHERE schedule_ref IN (SELECT ref FROM dots_schedules WHERE task_id=?)",
	).run(id);
	db.query("DELETE FROM dots_schedules WHERE task_id=?").run(id);
	db.query(
		"DELETE FROM dots_deliveries WHERE command_id IN (SELECT id FROM dots_commands WHERE task_id=?)",
	).run(id);
	for (const table of [
		"dots_dialogue_receipts",
		"dots_sessions",
		"dots_reports",
		"dots_commands",
	])
		db.query(`DELETE FROM ${table} WHERE task_id=?`).run(id);
}
