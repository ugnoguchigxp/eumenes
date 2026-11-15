import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { VideoJob } from "../../larm/contracts";

export const migrations: readonly Migration[] = [
	{
		id: "video/0001-requests",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE video_requests (
 id TEXT PRIMARY KEY, request_ref TEXT NOT NULL UNIQUE, binding TEXT NOT NULL,
 input_json TEXT NOT NULL, body_json TEXT, endpoint TEXT, job_json TEXT,
 state TEXT NOT NULL CHECK (state IN ('submitting','unconfirmed','rejected','tracking','finished')),
 error_code TEXT, retry_at INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX video_requests_binding ON video_requests(binding,created_at);
`,
	},
];

export type VideoRow = {
	id: string;
	request_ref: string;
	binding: string;
	input_json: string;
	body_json: string | null;
	endpoint: string | null;
	job_json: string | null;
	state: "submitting" | "unconfirmed" | "rejected" | "tracking" | "finished";
	error_code: string | null;
	retry_at: number;
	created_at: number;
	revision: number;
};

export const row = (db: Database, id: string) =>
	db
		.query("SELECT * FROM video_requests WHERE id=?")
		.get(id) as VideoRow | null;
export const byRequest = (db: Database, ref: string) =>
	db
		.query("SELECT * FROM video_requests WHERE request_ref=?")
		.get(ref) as VideoRow | null;
export const jobOf = (value: VideoRow) =>
	value.job_json ? (JSON.parse(value.job_json) as VideoJob) : null;
export const latest = (db: Database, binding: string) =>
	db
		.query(
			"SELECT * FROM video_requests WHERE binding=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
		)
		.get(binding) as VideoRow | null;
export const admissionRow = (db: Database, binding: string) =>
	db
		.query(
			`SELECT * FROM video_requests WHERE binding=? AND (
		state IN ('submitting','tracking','unconfirmed') OR job_json IS NOT NULL
	) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
		)
		.get(binding) as VideoRow | null;
export function insert(
	db: Database,
	id: string,
	ref: string,
	binding: string,
	input: string,
) {
	db.query(
		`INSERT INTO video_requests(id,request_ref,binding,input_json,state,created_at)
		VALUES (?,?,?,?,'submitting',?)`,
	).run(id, ref, binding, input, Date.now());
}
type Patch = Partial<
	Pick<
		VideoRow,
		"body_json" | "endpoint" | "job_json" | "state" | "error_code" | "retry_at"
	>
>;
export function patch(db: Database, id: string, value: Patch) {
	const entries = Object.entries(value);
	db.query(
		`UPDATE video_requests SET ${entries.map(([key]) => `${key}=?`).join(", ")}, revision=revision+1 WHERE id=?`,
	).run(...entries.map(([, v]) => v), id);
}

export function freezePost(
	db: Database,
	id: string,
	body: string,
	endpoint: string,
) {
	db.query("UPDATE video_requests SET body_json=?, endpoint=? WHERE id=?").run(
		body,
		endpoint,
		id,
	);
}
