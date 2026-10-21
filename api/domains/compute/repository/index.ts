import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type {
	Environment,
	JobState,
	JobView,
	Result,
	SubmitInput,
} from "../contracts";

export const migrations: readonly Migration[] = [
	{
		id: "compute/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE compute_jobs (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, origin TEXT NOT NULL,
 request_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE, body_json TEXT NOT NULL,
 binding TEXT NOT NULL, service_url TEXT NOT NULL, authorization_json TEXT, job_id TEXT, sent INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL, stage TEXT, progress_json TEXT, result_json TEXT, error_code TEXT, error_message TEXT,
 artifact_error TEXT, expires_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
 invalidated INTEGER NOT NULL DEFAULT 0, delete_requested INTEGER NOT NULL DEFAULT 0,
 announced INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL, cancel_until INTEGER,
 step INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX compute_jobs_owner ON compute_jobs(owner,conversation_id,created_at);
CREATE TABLE compute_artifacts (
 job_id TEXT NOT NULL REFERENCES compute_jobs(id), id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
 bytes INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY(job_id,id)
);
CREATE TABLE compute_commands (request_id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, operation TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE compute_focus (owner TEXT PRIMARY KEY, job_id TEXT NOT NULL);
CREATE TABLE compute_environment (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, service_url TEXT, description TEXT, environment_json TEXT, checked_at INTEGER NOT NULL, error_code TEXT);
`,
	},
];
export type JobRow = {
	id: string;
	owner: string;
	conversation_id: string;
	origin: "conversation" | "task" | "screen";
	request_id: string;
	idempotency_key: string;
	body_json: string;
	binding: string;
	service_url: string;
	job_id: string | null;
	authorization_json: string | null;
	sent: number;
	state: JobState;
	stage: string | null;
	progress_json: string | null;
	result_json: string | null;
	error_code: string | null;
	error_message: string | null;
	artifact_error: string | null;
	expires_at: string | null;
	cancel_requested: number;
	invalidated: number;
	delete_requested: number;
	announced: number;
	deadline: number;
	cancel_until: number | null;
	step: number;
	revision: number;
	created_at: number;
	updated_at: number;
};
export const row = (db: Database, id: string) =>
	db.query("SELECT * FROM compute_jobs WHERE id=?").get(id) as JobRow | null;
export function owned(
	db: Database,
	owner: string,
	id: string,
	conversationId?: string,
) {
	const r = row(db, id);
	if (
		!r ||
		r.owner !== owner ||
		(conversationId !== undefined && r.conversation_id !== conversationId)
	)
		throw new Error("compute_not_found");
	return r;
}
export function patch(
	db: Database,
	id: string,
	value: Partial<Omit<JobRow, "id">>,
) {
	const entries = Object.entries({ ...value, updated_at: Date.now() });
	db.query(
		`UPDATE compute_jobs SET ${entries.map(([k]) => `${k}=?`).join(",")},revision=revision+1 WHERE id=?`,
	).run(...entries.map(([, v]) => v ?? null), id);
	return row(db, id)!;
}
export function view(db: Database, r: JobRow): JobView {
	const body = JSON.parse(r.body_json) as SubmitInput;
	const result = r.result_json ? (JSON.parse(r.result_json) as Result) : null;
	const ready = new Set(
		(
			db
				.query("SELECT id FROM compute_artifacts WHERE job_id=?")
				.all(r.id) as Array<{ id: string }>
		).map((a) => a.id),
	);
	return {
		id: r.id,
		state: r.state,
		stage: r.stage,
		code: body.code,
		cancelRequested: !!r.cancel_requested,
		progress: r.progress_json ? JSON.parse(r.progress_json) : null,
		result,
		error: r.error_code
			? {
					code: r.error_code,
					...(r.error_message ? { message: r.error_message } : {}),
				}
			: null,
		artifactError: r.artifact_error,
		artifacts: (result?.artifacts ?? []).map((a) => ({
			...a,
			ready: ready.has(a.id),
		})),
		expiresAt: r.expires_at,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		revision: r.revision,
	};
}
export function list(db: Database, owner: string, conversationId?: string) {
	const rows =
		conversationId === undefined
			? db
					.query(
						"SELECT * FROM compute_jobs WHERE owner=? ORDER BY created_at DESC,id LIMIT 50",
					)
					.all(owner)
			: db
					.query(
						"SELECT * FROM compute_jobs WHERE owner=? AND conversation_id=? ORDER BY created_at DESC,id LIMIT 50",
					)
					.all(owner, conversationId);
	return (rows as JobRow[]).map((r) => view(db, r));
}
export type EnvironmentRow = {
	binding: string;
	service_url: string | null;
	description: string | null;
	environment_json: string | null;
	checked_at: number;
	error_code: string | null;
};
export const environmentRow = (db: Database) =>
	db
		.query("SELECT * FROM compute_environment WHERE id=1")
		.get() as EnvironmentRow | null;
export function savedEnvironment(db: Database, binding: string | undefined) {
	const r = environmentRow(db);
	return r &&
		r.binding === binding &&
		!r.error_code &&
		r.environment_json &&
		r.service_url &&
		Date.now() - r.checked_at < 120_000
		? {
				url: r.service_url,
				description: r.description ?? "",
				environment: JSON.parse(r.environment_json) as Environment,
			}
		: null;
}
