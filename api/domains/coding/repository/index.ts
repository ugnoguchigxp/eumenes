import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type {
	CodingEvent,
	ExecutionReceipt,
	ExecutionSpec,
} from "../../../../packages/coding-runner/src/contracts";

export const migration = `
CREATE TABLE coding_workspaces (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
CREATE TABLE coding_workspace_reservations (workspace_id TEXT PRIMARY KEY REFERENCES coding_workspaces(id), execution_id TEXT NOT NULL);
CREATE TABLE coding_executions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, spec_json TEXT NOT NULL, receipt_json TEXT, state TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
CREATE INDEX coding_task_executions ON coding_executions(task_id,created_ms);
CREATE TABLE coding_operations (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES coding_executions(id), digest TEXT NOT NULL, spec_ref TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE coding_event_cursors (execution_id TEXT PRIMARY KEY REFERENCES coding_executions(id), seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE coding_evidence (execution_id TEXT NOT NULL REFERENCES coding_executions(id), seq INTEGER NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(execution_id,seq));
`;
export type WorkspaceBinding = {
	id: string;
	branch: string;
	available: boolean;
	reason: string | null;
};
export type ExecutionRow = {
	id: string;
	task_id: string;
	generation: number;
	epoch: number;
	spec_json: string;
	receipt_json: string | null;
	state: string;
	created_ms: number;
	updated_ms: number;
};
export function registerWorkspace(db: Database, value: WorkspaceBinding) {
	const old = getWorkspace(db, value.id);
	if (
		old &&
		old.branch !== value.branch &&
		db
			.query("SELECT 1 FROM coding_workspace_reservations WHERE workspace_id=?")
			.get(value.id)
	)
		throw new Error("coding_workspace_busy");
	db.query(
		"INSERT INTO coding_workspaces(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
	).run(value.id, JSON.stringify(value));
}
export function getWorkspace(
	db: Database,
	id: string,
): WorkspaceBinding | null {
	const row = db
		.query("SELECT data_json FROM coding_workspaces WHERE id=?")
		.get(id) as { data_json: string } | null;
	return row ? JSON.parse(row.data_json) : null;
}
export function workspaces(db: Database) {
	return (
		db.query("SELECT data_json FROM coding_workspaces ORDER BY id").all() as {
			data_json: string;
		}[]
	).map((r) => JSON.parse(r.data_json) as WorkspaceBinding);
}
export function get(db: Database, id: string) {
	return db
		.query("SELECT * FROM coding_executions WHERE id=?")
		.get(id) as ExecutionRow | null;
}
export function latest(db: Database, taskId: string) {
	return db
		.query(
			"SELECT * FROM coding_executions WHERE task_id=? ORDER BY rowid DESC LIMIT 1",
		)
		.get(taskId) as ExecutionRow | null;
}
export function operation(db: Database, id: string) {
	return db.query("SELECT * FROM coding_operations WHERE id=?").get(id) as {
		id: string;
		execution_id: string;
		digest: string;
		spec_ref: string;
		state: string;
	} | null;
}
export function insert(
	db: Database,
	spec: ExecutionSpec,
	operationDigest: string,
	specRef: string,
	now: number,
) {
	db.query(
		"INSERT INTO coding_executions(id,task_id,generation,epoch,spec_json,state,created_ms,updated_ms) VALUES(?,?,?,?,?,'intent',?,?)",
	).run(
		spec.executionId,
		spec.taskId,
		spec.generation,
		spec.authorityEpoch,
		JSON.stringify(spec),
		now,
		now,
	);
	db.query(
		"INSERT INTO coding_operations(id,execution_id,digest,spec_ref,state) VALUES(?,?,?,?,'intent')",
	).run(spec.operationId, spec.executionId, operationDigest, specRef);
	db.query(
		"INSERT INTO coding_workspace_reservations(workspace_id,execution_id) VALUES(?,?)",
	).run(spec.workspaceId, spec.executionId);
	db.query(
		"INSERT INTO coding_event_cursors(execution_id,seq) VALUES(?,0)",
	).run(spec.executionId);
}
export function reservation(db: Database, workspaceId: string) {
	return db
		.query(
			"SELECT execution_id FROM coding_workspace_reservations WHERE workspace_id=?",
		)
		.get(workspaceId) as { execution_id: string } | null;
}
export function updateReceipt(
	db: Database,
	receipt: ExecutionReceipt,
	confirmedStop = false,
) {
	db.query(
		"UPDATE coding_executions SET state=?,receipt_json=?,updated_ms=? WHERE id=?",
	).run(
		receipt.state,
		JSON.stringify(receipt),
		receipt.updatedAt,
		receipt.executionId,
	);
	db.query("UPDATE coding_operations SET state=? WHERE execution_id=?").run(
		receipt.state,
		receipt.executionId,
	);
	if (
		receipt.childrenStopped &&
		["stopped", "exited"].includes(receipt.state) &&
		(confirmedStop || cursor(db, receipt.executionId) === receipt.seq)
	)
		db.query(
			"DELETE FROM coding_workspace_reservations WHERE execution_id=?",
		).run(receipt.executionId);
}
export function unknown(db: Database, id: string, now: number) {
	db.query(
		"UPDATE coding_executions SET state='outcome_unknown',updated_ms=? WHERE id=?",
	).run(now, id);
	db.query(
		"UPDATE coding_operations SET state='outcome_unknown' WHERE execution_id=?",
	).run(id);
}
export function cursor(db: Database, id: string) {
	return (
		db
			.query("SELECT seq FROM coding_event_cursors WHERE execution_id=?")
			.get(id) as { seq: number }
	).seq;
}
export function events(db: Database, id: string, after: number, limit: number) {
	return (
		db
			.query(
				"SELECT data_json FROM coding_evidence WHERE execution_id=? AND seq>? ORDER BY seq LIMIT ?",
			)
			.all(id, after, limit) as { data_json: string }[]
	).map((r) => JSON.parse(r.data_json) as CodingEvent);
}
export function countEvents(
	db: Database,
	id: string,
	kind: CodingEvent["kind"],
) {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM coding_evidence WHERE execution_id=? AND json_extract(data_json,'$.kind')=?",
			)
			.get(id, kind) as { n: number }
	).n;
}
/** Newest events of one kind, newest first. */
export function lastEvents(
	db: Database,
	id: string,
	kind: CodingEvent["kind"],
	limit: number,
) {
	return (
		db
			.query(
				"SELECT data_json FROM coding_evidence WHERE execution_id=? AND json_extract(data_json,'$.kind')=? ORDER BY seq DESC LIMIT ?",
			)
			.all(id, kind, limit) as { data_json: string }[]
	).map((r) => JSON.parse(r.data_json) as CodingEvent);
}
export function oneEvent(db: Database, id: string, seq: number) {
	const row = db
		.query(
			"SELECT data_json FROM coding_evidence WHERE execution_id=? AND seq=?",
		)
		.get(id, seq) as { data_json: string } | null;
	return row ? (JSON.parse(row.data_json) as CodingEvent) : null;
}
export function append(db: Database, event: CodingEvent) {
	db.query(
		"INSERT INTO coding_evidence(execution_id,seq,data_json) VALUES(?,?,?)",
	).run(event.executionId, event.seq, JSON.stringify(event));
	db.query("UPDATE coding_event_cursors SET seq=? WHERE execution_id=?").run(
		event.seq,
		event.executionId,
	);
}
export function live(db: Database) {
	return db
		.query(
			"SELECT * FROM coding_executions WHERE state NOT IN ('stopped','exited')",
		)
		.all() as ExecutionRow[];
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "coding/0001-init", sql: migration },
];
