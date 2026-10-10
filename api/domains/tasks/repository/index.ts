import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type {
	WorkTask,
	TaskReceipt,
	TaskEvent,
	TaskQuestion,
	TaskOrigin,
} from "../contracts";

export const migration = `
CREATE TABLE work_tasks (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('registered','queued','active','waiting_user','paused','reconciling','stopping','completed','failed','cancelled')),
 data_json TEXT NOT NULL, origin_key TEXT UNIQUE, conversation_id TEXT,
 finished_ms INTEGER, body_expired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX work_tasks_state_seq ON work_tasks(state,seq);
CREATE INDEX work_tasks_conversation_seq ON work_tasks(conversation_id,seq);
CREATE TABLE work_task_grants (
 task_id TEXT NOT NULL REFERENCES work_tasks(id), epoch INTEGER NOT NULL,
 data_json TEXT NOT NULL, origin_json TEXT NOT NULL, PRIMARY KEY(task_id,epoch)
);
CREATE TABLE work_task_commands (
 scope TEXT NOT NULL, request_id TEXT NOT NULL, input_digest TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES work_tasks(id), receipt_json TEXT NOT NULL,
 PRIMARY KEY(scope,request_id)
);
CREATE TABLE work_task_events (
 task_id TEXT NOT NULL REFERENCES work_tasks(id), seq INTEGER NOT NULL,
 data_json TEXT NOT NULL, PRIMARY KEY(task_id,seq)
);
CREATE TABLE work_task_questions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES work_tasks(id),
 state TEXT NOT NULL CHECK(state IN ('open','answered','superseded')), data_json TEXT NOT NULL
);
CREATE UNIQUE INDEX work_task_one_question ON work_task_questions(task_id) WHERE state='open';
CREATE TABLE work_task_runtime (
 task_id TEXT PRIMARY KEY REFERENCES work_tasks(id), data_json TEXT NOT NULL
);
`;
/** Adds a trigger-maintained byte total plus indexes for retention (frozen once deployed). */
export const retentionMigration = `
CREATE TABLE work_task_storage (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL);
INSERT INTO work_task_storage(id,bytes) VALUES(1,
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))),0) FROM work_tasks) +
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))),0) FROM work_task_questions) +
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))+length(CAST(origin_json AS BLOB))),0) FROM work_task_grants) +
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))),0) FROM work_task_events) +
 (SELECT coalesce(sum(length(CAST(receipt_json AS BLOB))+length(input_digest)),0) FROM work_task_commands) +
 (SELECT coalesce(sum(length(CAST(data_json AS BLOB))),0) FROM work_task_runtime));
CREATE TRIGGER work_tasks_storage_ins AFTER INSERT ON work_tasks BEGIN
 UPDATE work_task_storage SET bytes=bytes+length(CAST(NEW.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_tasks_storage_upd AFTER UPDATE OF data_json ON work_tasks BEGIN
 UPDATE work_task_storage SET bytes=bytes-length(CAST(OLD.data_json AS BLOB))+length(CAST(NEW.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_tasks_storage_del AFTER DELETE ON work_tasks BEGIN
 UPDATE work_task_storage SET bytes=bytes-length(CAST(OLD.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_questions_storage_ins AFTER INSERT ON work_task_questions BEGIN
 UPDATE work_task_storage SET bytes=bytes+length(CAST(NEW.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_questions_storage_upd AFTER UPDATE ON work_task_questions BEGIN
 UPDATE work_task_storage SET bytes=bytes-length(CAST(OLD.data_json AS BLOB))+length(CAST(NEW.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_questions_storage_del AFTER DELETE ON work_task_questions BEGIN
 UPDATE work_task_storage SET bytes=bytes-length(CAST(OLD.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_grants_storage_ins AFTER INSERT ON work_task_grants BEGIN
 UPDATE work_task_storage SET bytes=bytes+length(CAST(NEW.data_json AS BLOB))+length(CAST(NEW.origin_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_grants_storage_upd AFTER UPDATE ON work_task_grants BEGIN
 UPDATE work_task_storage SET bytes=bytes-(length(CAST(OLD.data_json AS BLOB))+length(CAST(OLD.origin_json AS BLOB)))+(length(CAST(NEW.data_json AS BLOB))+length(CAST(NEW.origin_json AS BLOB))) WHERE id=1; END;
CREATE TRIGGER work_task_grants_storage_del AFTER DELETE ON work_task_grants BEGIN
 UPDATE work_task_storage SET bytes=bytes-(length(CAST(OLD.data_json AS BLOB))+length(CAST(OLD.origin_json AS BLOB))) WHERE id=1; END;
CREATE TRIGGER work_task_events_storage_ins AFTER INSERT ON work_task_events BEGIN
 UPDATE work_task_storage SET bytes=bytes+length(CAST(NEW.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_events_storage_upd AFTER UPDATE ON work_task_events BEGIN
 UPDATE work_task_storage SET bytes=bytes-length(CAST(OLD.data_json AS BLOB))+length(CAST(NEW.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_events_storage_del AFTER DELETE ON work_task_events BEGIN
 UPDATE work_task_storage SET bytes=bytes-length(CAST(OLD.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_commands_storage_ins AFTER INSERT ON work_task_commands BEGIN
 UPDATE work_task_storage SET bytes=bytes+length(CAST(NEW.receipt_json AS BLOB))+length(NEW.input_digest) WHERE id=1; END;
CREATE TRIGGER work_task_commands_storage_upd AFTER UPDATE ON work_task_commands BEGIN
 UPDATE work_task_storage SET bytes=bytes-(length(CAST(OLD.receipt_json AS BLOB))+length(OLD.input_digest))+(length(CAST(NEW.receipt_json AS BLOB))+length(NEW.input_digest)) WHERE id=1; END;
CREATE TRIGGER work_task_commands_storage_del AFTER DELETE ON work_task_commands BEGIN
 UPDATE work_task_storage SET bytes=bytes-(length(CAST(OLD.receipt_json AS BLOB))+length(OLD.input_digest)) WHERE id=1; END;
CREATE TRIGGER work_task_runtime_storage_ins AFTER INSERT ON work_task_runtime BEGIN
 UPDATE work_task_storage SET bytes=bytes+length(CAST(NEW.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_runtime_storage_upd AFTER UPDATE ON work_task_runtime BEGIN
 UPDATE work_task_storage SET bytes=bytes-length(CAST(OLD.data_json AS BLOB))+length(CAST(NEW.data_json AS BLOB)) WHERE id=1; END;
CREATE TRIGGER work_task_runtime_storage_del AFTER DELETE ON work_task_runtime BEGIN
 UPDATE work_task_storage SET bytes=bytes-length(CAST(OLD.data_json AS BLOB)) WHERE id=1; END;
CREATE INDEX work_tasks_metadata_expiry ON work_tasks(json_extract(data_json,'$.metadataExpired'), finished_ms);
CREATE INDEX work_tasks_finished ON work_tasks(finished_ms) WHERE finished_ms IS NOT NULL;
`;
type TaskRow = { seq: number; data_json: string };
const task = (row: TaskRow | null): WorkTask | null =>
	row ? JSON.parse(row.data_json) : null;
export function get(db: Database, id: string) {
	return task(
		db
			.query("SELECT data_json FROM work_tasks WHERE id=?")
			.get(id) as TaskRow | null,
	);
}
export function byOrigin(db: Database, key: string) {
	return task(
		db
			.query("SELECT data_json FROM work_tasks WHERE origin_key=?")
			.get(key) as TaskRow | null,
	);
}
export function insert(
	db: Database,
	value: WorkTask,
	originKey: string | null,
) {
	db.query(
		"INSERT INTO work_tasks(id,state,data_json,origin_key,conversation_id) VALUES(?,?,?,?,?)",
	).run(
		value.id,
		value.state,
		JSON.stringify(value),
		originKey,
		value.origin.source === "conversation" ? value.origin.conversationId : null,
	);
}
export function put(db: Database, value: WorkTask) {
	db.query(
		"UPDATE work_tasks SET state=?,data_json=?,finished_ms=?,body_expired=? WHERE id=?",
	).run(
		value.state,
		JSON.stringify(value),
		value.finishedAt === null ? null : Date.parse(value.finishedAt),
		Number(value.bodyExpired),
		value.id,
	);
	// Bun's `changes` also counts trigger writes, so ask SQLite for this statement only.
	const { n } = db.query("SELECT changes() AS n").get() as { n: number };
	if (n !== 1) throw new Error("task_not_found");
}
export function grant(db: Database, value: WorkTask, origin: TaskOrigin) {
	db.query(
		"INSERT INTO work_task_grants(task_id,epoch,data_json,origin_json) VALUES(?,?,?,?)",
	).run(
		value.id,
		value.authorityEpoch,
		JSON.stringify(value.grant),
		JSON.stringify(origin),
	);
}
export function command(db: Database, scope: string, requestId: string) {
	const row = db
		.query(
			"SELECT input_digest,receipt_json FROM work_task_commands WHERE scope=? AND request_id=?",
		)
		.get(scope, requestId) as {
		input_digest: string;
		receipt_json: string;
	} | null;
	return row
		? {
				digest: row.input_digest,
				receipt: JSON.parse(row.receipt_json) as TaskReceipt,
			}
		: null;
}
export function recordCommand(
	db: Database,
	scope: string,
	requestId: string,
	digest: string,
	receipt: TaskReceipt,
) {
	db.query(
		"INSERT INTO work_task_commands(scope,request_id,input_digest,task_id,receipt_json) VALUES(?,?,?,?,?)",
	).run(scope, requestId, digest, receipt.taskId, JSON.stringify(receipt));
}
export function recordEvent(db: Database, value: TaskEvent) {
	db.query(
		"INSERT INTO work_task_events(task_id,seq,data_json) VALUES(?,?,?)",
	).run(value.taskId, value.seq, JSON.stringify(value));
}
export function list(
	db: Database,
	query: {
		state?: string;
		conversationId?: string;
		cursor?: number;
		limit: number;
	},
) {
	return (
		db
			.query(`SELECT seq,data_json FROM work_tasks WHERE
 (? IS NULL OR state=?) AND (? IS NULL OR conversation_id=?) AND (? IS NULL OR seq<?)
 ORDER BY seq DESC LIMIT ?`)
			.all(
				query.state ?? null,
				query.state ?? null,
				query.conversationId ?? null,
				query.conversationId ?? null,
				query.cursor ?? null,
				query.cursor ?? null,
				query.limit,
			) as TaskRow[]
	).map((row) => ({ seq: row.seq, task: task(row)! }));
}
export function events(
	db: Database,
	id: string,
	cursor: number,
	limit: number,
): TaskEvent[] {
	return (
		db
			.query(
				"SELECT data_json FROM work_task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?",
			)
			.all(id, cursor, limit) as { data_json: string }[]
	).map((r) => JSON.parse(r.data_json));
}
export function question(db: Database, id: string): TaskQuestion | null {
	const row = db
		.query("SELECT data_json FROM work_task_questions WHERE id=?")
		.get(id) as { data_json: string } | null;
	return row ? JSON.parse(row.data_json) : null;
}
export function openQuestion(
	db: Database,
	taskId: string,
): TaskQuestion | null {
	const row = db
		.query(
			"SELECT data_json FROM work_task_questions WHERE task_id=? AND state='open'",
		)
		.get(taskId) as { data_json: string } | null;
	return row ? JSON.parse(row.data_json) : null;
}
export function putQuestion(db: Database, q: TaskQuestion) {
	db.query(`INSERT INTO work_task_questions(id,task_id,state,data_json) VALUES(?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET state=excluded.state,data_json=excluded.data_json`).run(
		q.id,
		q.taskId,
		q.state,
		JSON.stringify(q),
	);
}
export function live(db: Database): WorkTask[] {
	return (
		db
			.query(
				"SELECT data_json FROM work_tasks WHERE finished_ms IS NULL ORDER BY seq",
			)
			.all() as TaskRow[]
	).map((r) => task(r)!);
}
export function capacity(db: Database) {
	return db
		.query(`SELECT count(*) AS total, coalesce(sum(finished_ms IS NULL),0) AS live,
 (SELECT bytes FROM work_task_storage WHERE id=1) AS bytes FROM work_tasks`)
		.get() as { total: number; live: number; bytes: number };
}
export function expiredBodies(
	db: Database,
	before: number,
	limit: number,
): WorkTask[] {
	return (
		db
			.query(
				"SELECT data_json FROM work_tasks WHERE finished_ms<=? AND body_expired=0 ORDER BY seq LIMIT ?",
			)
			.all(before, limit) as TaskRow[]
	).map((r) => task(r)!);
}
export function clearPrivateHistory(db: Database, id: string) {
	db.query("DELETE FROM work_task_grants WHERE task_id=?").run(id);
	db.query("DELETE FROM work_task_questions WHERE task_id=?").run(id);
}
export function detachConversation(db: Database, id: string) {
	db.query("UPDATE work_tasks SET conversation_id=NULL WHERE id=?").run(id);
}
export interface TaskRuntimeRefs {
	scheduleId?: string;
	dispatchJobId?: string;
	observeJobId?: string;
	stopJobId?: string;
}
export function runtime(db: Database, id: string): TaskRuntimeRefs {
	const row = db
		.query("SELECT data_json FROM work_task_runtime WHERE task_id=?")
		.get(id) as { data_json: string } | null;
	return row ? JSON.parse(row.data_json) : {};
}
export function setRuntime(db: Database, id: string, refs: TaskRuntimeRefs) {
	const previous = runtime(db, id);
	const next = { ...previous, ...refs };
	if (JSON.stringify(previous) === JSON.stringify(next)) return;
	db.query(
		"INSERT INTO work_task_runtime(task_id,data_json) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data_json=excluded.data_json",
	).run(id, JSON.stringify(next));
}
export function expiredMetadata(db: Database, before: number): WorkTask[] {
	return (
		db
			.query(
				"SELECT data_json FROM work_tasks WHERE finished_ms<=? AND json_extract(data_json,'$.metadataExpired')=0 LIMIT 100",
			)
			.all(before) as TaskRow[]
	).map((r) => task(r)!);
}
export function purgeCandidates(
	db: Database,
	before: number,
	limit: number,
	exclude: readonly string[] = [],
): WorkTask[] {
	return (
		db
			.query(`SELECT data_json FROM work_tasks
 WHERE finished_ms<=? AND json_extract(data_json,'$.metadataExpired')=1
 AND id NOT IN (SELECT value FROM json_each(?))
 ORDER BY finished_ms, id LIMIT ?`)
			.all(before, JSON.stringify(exclude), limit) as TaskRow[]
	).map((r) => task(r)!);
}
export function purgeTask(db: Database, id: string) {
	for (const table of [
		"work_task_runtime",
		"work_task_events",
		"work_task_questions",
		"work_task_grants",
		"work_task_commands",
	])
		db.query(`DELETE FROM ${table} WHERE task_id=?`).run(id);
	db.query("DELETE FROM work_tasks WHERE id=?").run(id);
}
export function clearRuntimeHistory(db: Database, t: WorkTask) {
	db.query("DELETE FROM work_task_runtime WHERE task_id=?").run(t.id);
	db.query("DELETE FROM work_task_events WHERE task_id=? AND seq<?").run(
		t.id,
		t.eventSeq,
	);
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "tasks/0001-init", sql: migration },
	{
		id: "tasks/0002-retention",
		after: ["tasks/0001-init"],
		sql: retentionMigration,
	},
];
