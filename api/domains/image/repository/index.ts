import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ImageRecord } from "../contracts";
export const migrations: readonly Migration[] = [
	{
		id: "image/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE image_generations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
 record_json TEXT NOT NULL, request_json TEXT NOT NULL, plan_json TEXT, bindings_json TEXT NOT NULL,
 deadline INTEGER NOT NULL, queue_job_id TEXT
);
CREATE INDEX image_conversation ON image_generations(conversation_id);
`,
	},
	{
		id: "image/0002-imports",
		after: ["image/0001-init"],
		sql: `CREATE TABLE image_imports (
 request_id TEXT PRIMARY KEY, principal TEXT NOT NULL, connection TEXT NOT NULL,
 original_digest TEXT NOT NULL, bytes BLOB, attempted INTEGER NOT NULL DEFAULT 0,
 view_json TEXT NOT NULL, expires_at INTEGER NOT NULL
);`,
	},
];
export type Row = {
	id: string;
	run_id: string;
	conversation_id: string;
	record_json: string;
	request_json: string;
	plan_json: string | null;
	bindings_json: string;
	deadline: number;
	queue_job_id: string | null;
};
export function row(db: Database, id: string) {
	return db
		.query("SELECT * FROM image_generations WHERE id=?")
		.get(id) as Row | null;
}
export function byRun(db: Database, id: string) {
	return db
		.query("SELECT * FROM image_generations WHERE run_id=?")
		.get(id) as Row | null;
}
export function record(r: Row): ImageRecord {
	return JSON.parse(r.record_json);
}
export function patch(db: Database, id: string, change: Partial<ImageRecord>) {
	const r = row(db, id);
	if (!r) throw new Error("image_not_found");
	const v = { ...record(r), ...change, updatedAt: Date.now() };
	db.query("UPDATE image_generations SET record_json=? WHERE id=?").run(
		JSON.stringify(v),
		id,
	);
	return v;
}
export function list(db: Database, conversationId: string) {
	return (
		db
			.query(
				"SELECT record_json FROM image_generations WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100",
			)
			.all(conversationId) as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as ImageRecord);
}

/** Generations running now, and the newest completion and failure since `since` (monitoring). */
export function activity(db: Database, since: number) {
	const records = (
		db
			.query(
				"SELECT record_json FROM image_generations ORDER BY rowid DESC LIMIT 50",
			)
			.all() as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as ImageRecord);
	const recent = records
		.filter((r) => r.updatedAt >= since)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const success = recent.find((r) => r.state === "completed");
	const failure = recent.find((r) => r.state === "failed");
	return {
		running: records.filter(
			(r) => r.state === "planning" || r.state === "generating",
		).length,
		lastSuccessAt: success?.updatedAt ?? null,
		lastFailure: failure
			? { at: failure.updatedAt, reason: failure.errorCode ?? "failed" }
			: null,
	};
}
