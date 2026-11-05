import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ExecutionStatus } from "../../tool-runtime";
import type { HostState } from "../contracts";

export const migrations: readonly Migration[] = [
	{
		id: "pursuit/0001-host",
		after: ["queue/0001-init", "pursuit-core/0008"],
		sql: `
CREATE TABLE pursuit_runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state TEXT NOT NULL,
 epoch INTEGER NOT NULL, revision INTEGER NOT NULL, deadline INTEGER NOT NULL,
 step INTEGER NOT NULL, core_id TEXT, data_json TEXT, job_id TEXT,
 active_request TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX pursuit_runs_active ON pursuit_runs(state, deadline);
CREATE TABLE pursuit_web_operations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pursuit_runs(id), epoch INTEGER NOT NULL,
 attempt_id TEXT NOT NULL UNIQUE, external_id TEXT NOT NULL, job_id TEXT NOT NULL,
 outcome_json TEXT, adopted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pursuit_documents (
 run_id TEXT NOT NULL REFERENCES pursuit_runs(id), epoch INTEGER NOT NULL, id TEXT NOT NULL,
 url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, fetched_at TEXT NOT NULL,
 truncated INTEGER NOT NULL, PRIMARY KEY (run_id, epoch, id)
);
CREATE TABLE pursuit_notices (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pursuit_runs(id), epoch INTEGER NOT NULL,
 ordinal INTEGER NOT NULL, state TEXT NOT NULL, UNIQUE (run_id, epoch, ordinal)
);
`,
	},
];

export type RunRow = {
	id: string;
	conversation_id: string;
	state: ExecutionStatus;
	epoch: number;
	revision: number;
	deadline: number;
	step: number;
	core_id: string | null;
	data_json: string | null;
	job_id: string | null;
	active_request: string | null;
	created_at: number;
	updated_at: number;
};
export type WebRow = {
	id: string;
	run_id: string;
	epoch: number;
	attempt_id: string;
	external_id: string;
	job_id: string;
	outcome_json: string | null;
	adopted: number;
};
export type DocumentRow = {
	run_id: string;
	epoch: number;
	id: string;
	url: string;
	title: string;
	text: string;
	fetched_at: string;
	truncated: number;
};
export const active = (row: RunRow) =>
	["queued", "deciding", "waiting_child", "waiting_user"].includes(row.state);
export const rowOf = (db: Database, id: string) =>
	db.query("SELECT * FROM pursuit_runs WHERE id=?").get(id) as RunRow | null;
export const stateOf = (row: RunRow) => JSON.parse(row.data_json!) as HostState;
export function save(db: Database, row: RunRow, state: HostState, now: number) {
	const changed = db
		.query(
			"UPDATE pursuit_runs SET state=?,epoch=?,revision=revision+1,deadline=?,step=?,core_id=?,data_json=?,job_id=?,active_request=?,updated_at=? WHERE id=? AND revision=?",
		)
		.run(
			row.state,
			row.epoch,
			row.deadline,
			row.step,
			row.core_id,
			JSON.stringify(state),
			row.job_id,
			row.active_request,
			now,
			row.id,
			row.revision,
		);
	if (changed.changes !== 1) throw new Error("pursuit_revision_conflict");
	row.revision++;
}
export const documents = (db: Database, row: RunRow) =>
	db
		.query(
			"SELECT * FROM pursuit_documents WHERE run_id=? AND epoch=? ORDER BY rowid",
		)
		.all(row.id, row.epoch) as DocumentRow[];
export const pendingWeb = (db: Database, row: RunRow) =>
	db
		.query(
			"SELECT * FROM pursuit_web_operations WHERE run_id=? AND epoch=? AND adopted=0",
		)
		.all(row.id, row.epoch) as WebRow[];
