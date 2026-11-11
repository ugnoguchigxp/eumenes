import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ExecutionStatus } from "../../tool-runtime";
import type { HostState, NoticeState } from "../contracts";

export const migrations: readonly Migration[] = [
	{
		id: "web-note/0001-runs",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE web_note_runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state TEXT NOT NULL,
 revision INTEGER NOT NULL, deadline INTEGER NOT NULL, job_id TEXT, data_json TEXT,
 notice TEXT NOT NULL DEFAULT 'none', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX web_note_runs_active ON web_note_runs(state, deadline);
`,
	},
];

export type RunRow = {
	id: string;
	conversation_id: string;
	state: ExecutionStatus;
	revision: number;
	deadline: number;
	job_id: string | null;
	data_json: string | null;
	notice: NoticeState;
	created_at: number;
	updated_at: number;
};
export const active = (row: RunRow) =>
	["queued", "deciding"].includes(row.state);
export const rowOf = (db: Database, id: string) =>
	db.query("SELECT * FROM web_note_runs WHERE id=?").get(id) as RunRow | null;
export const stateOf = (row: RunRow) => JSON.parse(row.data_json!) as HostState;
export function save(db: Database, row: RunRow, state: HostState, now: number) {
	const changed = db
		.query(
			"UPDATE web_note_runs SET state=?,revision=revision+1,deadline=?,job_id=?,data_json=?,notice=?,updated_at=? WHERE id=? AND revision=?",
		)
		.run(
			row.state,
			row.deadline,
			row.job_id,
			JSON.stringify(state),
			row.notice,
			now,
			row.id,
			row.revision,
		);
	if (changed.changes !== 1) throw new Error("web_note_revision_conflict");
	row.revision++;
}
