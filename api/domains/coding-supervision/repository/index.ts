import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Supervisor, StepIntent, Decision } from "../contracts";
import type { TaskFence } from "../../tasks";
export const migration = `
CREATE TABLE coding_supervisors(task_id TEXT PRIMARY KEY REFERENCES work_tasks(id),data_json TEXT NOT NULL);
CREATE TABLE coding_observations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES work_tasks(id),fingerprint TEXT NOT NULL,created_ms INTEGER NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE coding_decisions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES work_tasks(id),status TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE coding_steps(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES work_tasks(id),status TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE coding_supervision_budgets(task_id TEXT PRIMARY KEY REFERENCES work_tasks(id),decisions_used INTEGER NOT NULL,repair_loops INTEGER NOT NULL,blockers_json TEXT NOT NULL);
`;
export interface DecisionRecord {
	id: string;
	taskId: string;
	status: "pending" | "applied" | "superseded" | "failed";
	fence: TaskFence;
	phase: string | null;
	fingerprint: string;
	observationDigest: string;
	requestId: string;
	deadline: number;
	repair: number;
	inputTokenCount: number;
	jobId: string;
	messages: Array<{ role: "system" | "user"; content: string }>;
	proposal: Decision | null;
}
export interface StepRecord {
	intent: StepIntent;
	status: "pending" | "running" | "applied" | "superseded" | "outcome_unknown";
	jobId: string;
}
function read<T>(db: Database, table: string, id: string): T | null {
	const row = db
		.query(
			`SELECT data_json FROM ${table} WHERE ${table === "coding_supervisors" ? "task_id" : "id"}=?`,
		)
		.get(id) as { data_json: string } | null;
	return row ? JSON.parse(row.data_json) : null;
}
export const get = (db: Database, id: string) =>
	read<Supervisor>(db, "coding_supervisors", id);
export const decision = (db: Database, id: string) =>
	read<DecisionRecord>(db, "coding_decisions", id);
export const step = (db: Database, id: string) =>
	read<StepRecord>(db, "coding_steps", id);
export function put(db: Database, s: Supervisor) {
	db.query(
		"INSERT INTO coding_supervisors VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data_json=excluded.data_json",
	).run(s.taskId, JSON.stringify(s));
	db.query(
		"INSERT INTO coding_supervision_budgets VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET decisions_used=excluded.decisions_used,repair_loops=excluded.repair_loops,blockers_json=excluded.blockers_json",
	).run(
		s.taskId,
		s.decisionsUsed,
		s.repairLoops,
		JSON.stringify(s.blockerAttempts),
	);
}
export function putDecision(db: Database, r: DecisionRecord) {
	db.query(
		"INSERT INTO coding_decisions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json",
	).run(r.id, r.taskId, r.status, JSON.stringify(r));
}
export function putStep(db: Database, r: StepRecord) {
	db.query(
		"INSERT INTO coding_steps VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json",
	).run(r.intent.id, r.intent.taskId, r.status, JSON.stringify(r));
}
export function observe(db: Database, s: Supervisor, at: number) {
	db.query("INSERT INTO coding_observations VALUES(?,?,?,?,?)").run(
		crypto.randomUUID(),
		s.taskId,
		s.fingerprint!,
		at,
		JSON.stringify(s.observation),
	);
	// Keep a bounded per-task history, while decisions retain the exact input they used.
	db.query(
		"DELETE FROM coding_observations WHERE task_id=? AND id NOT IN (SELECT id FROM coding_observations WHERE task_id=? ORDER BY created_ms DESC,rowid DESC LIMIT 128)",
	).run(s.taskId, s.taskId);
}
export function all(db: Database): Supervisor[] {
	return (
		db.query("SELECT data_json FROM coding_supervisors").all() as {
			data_json: string;
		}[]
	).map((r) => JSON.parse(r.data_json));
}
export function purge(db: Database, id: string) {
	for (const table of [
		"coding_observations",
		"coding_decisions",
		"coding_steps",
		"coding_supervision_budgets",
		"coding_supervisors",
	])
		db.query(`DELETE FROM ${table} WHERE task_id=?`).run(id);
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "coding-supervision/0001-init", sql: migration },
	{
		id: "coding-supervision/0002-indexes",
		after: ["coding-supervision/0001-init"],
		sql: `
CREATE INDEX coding_observations_task_created ON coding_observations(task_id, created_ms);
CREATE INDEX coding_decisions_task ON coding_decisions(task_id);
CREATE INDEX coding_steps_task ON coding_steps(task_id);
`,
	},
];
