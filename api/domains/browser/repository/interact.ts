import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { InteractMeta } from "../contracts/interact";

/** Only coordination metadata: the package owns the run and operation states. */
export const interactMigrations: readonly Migration[] = [
	{
		id: "browser/0007-interact",
		after: ["interact-package/0002"],
		sql: `
CREATE TABLE browser_interact_runs (
 run_id TEXT PRIMARY KEY REFERENCES interact_runs(run_id) ON DELETE CASCADE,
 owner TEXT NOT NULL, conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, input_digest TEXT NOT NULL, execution_id TEXT,
 generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
 job_id TEXT, question_id TEXT, question_kind TEXT, question_deadline INTEGER, approval_id TEXT, approval_observation TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(owner, conversation_id, request_id)
);
CREATE TABLE browser_interact_captures (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES browser_interact_runs(run_id) ON DELETE CASCADE,
 file_ref TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL,
 range TEXT NOT NULL CHECK(range IN ('viewport','full-page','element')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
`,
	},
];
export const interactMeta = (db: Database, id: string) =>
	db
		.query("SELECT * FROM browser_interact_runs WHERE run_id=?")
		.get(id) as InteractMeta | null;
export const interactByRequest = (
	db: Database,
	owner: string,
	conversation: string,
	request: string,
) =>
	db
		.query(
			"SELECT * FROM browser_interact_runs WHERE owner=? AND conversation_id=? AND request_id=?",
		)
		.get(owner, conversation, request) as InteractMeta | null;

export type InteractCaptureResource = {
	id: string;
	run_id: string;
	range: "viewport" | "full-page" | "element";
	created_at: number;
	captured_at: number;
	png_width: number;
	png_height: number;
	tab_title: null;
	tab_url: null;
};
const captureColumns =
	"c.id,c.run_id,c.range,c.created_at,c.created_at AS captured_at,c.width AS png_width,c.height AS png_height,NULL AS tab_title,NULL AS tab_url";
export function readyInteractCaptures(
	db: Database,
	owner: string,
	limit: number,
	now: number,
	id?: string,
) {
	return db
		.query(
			`SELECT ${captureColumns} FROM browser_interact_captures c JOIN browser_interact_runs m ON m.run_id=c.run_id WHERE m.owner=? AND c.expires_at>? AND m.expires_at>? ${id ? "AND c.id=?" : ""} ORDER BY c.created_at DESC LIMIT ?`,
		)
		.all(
			...(id ? [owner, now, now, id, limit] : [owner, now, now, limit]),
		) as InteractCaptureResource[];
}
