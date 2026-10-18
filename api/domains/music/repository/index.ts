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
	{
		id: "music/0002-playlists",
		after: ["music/0001-init"],
		sql: `
CREATE TABLE music_playlists (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
 record_json TEXT NOT NULL, request_json TEXT NOT NULL, bindings_json TEXT NOT NULL,
 deadline INTEGER NOT NULL, queue_job_id TEXT
);
CREATE INDEX music_playlist_conversation ON music_playlists(conversation_id);
`,
	},
	{
		id: "music/0003-artwork",
		after: ["music/0001-init"],
		sql: `
ALTER TABLE music_generations ADD COLUMN artwork BLOB;
ALTER TABLE music_generations ADD COLUMN artwork_mime TEXT;
`,
	},
];
const COLUMNS =
	"id, run_id, conversation_id, record_json, request_json, plan_json, bindings_json, deadline, queue_job_id";
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
		.query(`SELECT ${COLUMNS} FROM music_generations WHERE id=?`)
		.get(id) as Row | null;
}
/** Media BLOBs are read only when they are served. */
export function media(db: Database, id: string, kind: "audio" | "artwork") {
	return db
		.query(
			kind === "audio"
				? "SELECT audio AS bytes, NULL AS mime FROM music_generations WHERE id=?"
				: "SELECT artwork AS bytes, artwork_mime AS mime FROM music_generations WHERE id=?",
		)
		.get(id) as { bytes: Uint8Array | null; mime: string | null } | null;
}
export function byRun(db: Database, id: string) {
	return db
		.query(`SELECT ${COLUMNS} FROM music_generations WHERE run_id=?`)
		.get(id) as Row | null;
}
/** A LARM library track id is the LARM job id recorded while the track was generated here. */
export function byTrack(db: Database, trackId: string) {
	return db
		.query(
			`SELECT ${COLUMNS} FROM music_generations WHERE json_extract(record_json,'$.jobId')=? ORDER BY rowid DESC LIMIT 1`,
		)
		.get(trackId) as Row | null;
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

/** Generations running now, and the newest completion and failure since `since` (monitoring). */
export function activity(db: Database, since: number) {
	const records = (
		db
			.query(
				"SELECT record_json FROM music_generations ORDER BY rowid DESC LIMIT 50",
			)
			.all() as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as MusicRecord);
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
