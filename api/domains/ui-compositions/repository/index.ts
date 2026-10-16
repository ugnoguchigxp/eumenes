import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "ui-compositions/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE ui_compositions (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
 prompt TEXT NOT NULL, motif_id TEXT, definition_json TEXT, fields_json TEXT,
 state TEXT NOT NULL, generation INTEGER NOT NULL, request_id TEXT NOT NULL,
 job_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ui_compositions_scope_updated ON ui_compositions(scope, updated_at DESC);
CREATE TABLE ui_composition_responses (
 id TEXT PRIMARY KEY, composition_id TEXT NOT NULL REFERENCES ui_compositions(id),
 generation INTEGER NOT NULL, values_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX ui_composition_responses_composition ON ui_composition_responses(composition_id, created_at DESC);
CREATE TABLE ui_composition_receipts (
 id TEXT PRIMARY KEY, composition_id TEXT NOT NULL, receipt_json TEXT NOT NULL
);
`,
	},
];

export type CompositionRow = {
	id: string;
	scope: string;
	title: string;
	description: string;
	prompt: string;
	motif_id: string | null;
	definition_json: string | null;
	fields_json: string | null;
	state: "generating" | "ready" | "failed" | "cancelled";
	generation: number;
	request_id: string;
	job_id: string | null;
	error_code: string | null;
	created_at: number;
	updated_at: number;
};
export const get = (db: Database, id: string) =>
	db
		.query("SELECT * FROM ui_compositions WHERE id=?")
		.get(id) as CompositionRow | null;
export const list = (db: Database, scope: string) =>
	db
		.query(
			"SELECT * FROM ui_compositions WHERE scope=? ORDER BY updated_at DESC LIMIT 100",
		)
		.all(scope) as CompositionRow[];
export function receipt(db: Database, id: string) {
	const row = db
		.query("SELECT receipt_json FROM ui_composition_receipts WHERE id=?")
		.get(id) as { receipt_json: string } | null;
	return row
		? (JSON.parse(row.receipt_json) as {
				projectId: string;
				state: string;
				responseId?: string;
			})
		: null;
}
export function saveReceipt(
	db: Database,
	id: string,
	value: { projectId: string; state: string; responseId?: string },
) {
	db.query(
		"INSERT INTO ui_composition_receipts(id,composition_id,receipt_json) VALUES(?,?,?)",
	).run(id, value.projectId, JSON.stringify(value));
}
