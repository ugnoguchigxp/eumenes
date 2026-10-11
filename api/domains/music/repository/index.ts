import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { MusicRecord } from "../contracts";
export const migrations: readonly Migration[] = [
	{
		id: "music/0001-init",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE music_generations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
 record_json TEXT NOT NULL, request_json TEXT NOT NULL, plan_json TEXT, bindings_json TEXT NOT NULL,
 deadline INTEGER NOT NULL, queue_job_id TEXT, audio BLOB
);
CREATE INDEX music_conversation ON music_generations(conversation_id);
`,
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
	audio: Uint8Array | null;
};
export function row(db: Database, id: string) {
	return db
		.query("SELECT * FROM music_generations WHERE id=?")
		.get(id) as Row | null;
}
export function byRun(db: Database, id: string) {
	return db
		.query("SELECT * FROM music_generations WHERE run_id=?")
		.get(id) as Row | null;
}
export function record(r: Row): MusicRecord {
	return JSON.parse(r.record_json);
}
export function patch(db: Database, id: string, change: Partial<MusicRecord>) {
	const r = row(db, id);
	if (!r) throw new Error("music_not_found");
	const v = { ...record(r), ...change, updatedAt: Date.now() };
	db.query("UPDATE music_generations SET record_json=? WHERE id=?").run(
		JSON.stringify(v),
		id,
	);
	return v;
}
export function list(db: Database, conversationId: string) {
	return (
		db
			.query(
				"SELECT record_json FROM music_generations WHERE conversation_id=? ORDER BY rowid DESC LIMIT 8",
			)
			.all(conversationId) as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as MusicRecord);
}
