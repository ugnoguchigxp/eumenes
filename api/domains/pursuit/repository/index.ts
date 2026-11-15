import type { Database } from "bun:sqlite";
import type { ExecutionResult } from "../../tool-runtime";

export type RunRow = {
	id: string;
	conversation_id: string;
	state: string;
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
type SavedReport = {
	request: string;
	saveDocument?: boolean;
	result: ExecutionResult | null;
};
export const rowOf = (db: Database, id: string) =>
	db.query("SELECT * FROM pursuit_runs WHERE id=?").get(id) as RunRow | null;
export const stateOf = (row: RunRow) =>
	JSON.parse(row.data_json!) as SavedReport;
