import type { Database } from "bun:sqlite";
import type { PlaylistRecord } from "../contracts";
export type PlaylistRow = {
	id: string;
	run_id: string;
	record_json: string;
	request_json: string;
	bindings_json: string;
	deadline: number;
	queue_job_id: string | null;
};
export function playlistRow(db: Database, id: string) {
	return db
		.query("SELECT * FROM music_playlists WHERE id=?")
		.get(id) as PlaylistRow | null;
}
export function playlistByRun(db: Database, id: string) {
	return db
		.query(
			"SELECT * FROM music_playlists WHERE run_id=? AND json_extract(request_json,'$.execution') IS NULL",
		)
		.get(id) as PlaylistRow | null;
}
export function playlistRecordOf(row: PlaylistRow): PlaylistRecord {
	return JSON.parse(row.record_json);
}
export function patchPlaylist(
	db: Database,
	id: string,
	change: Partial<PlaylistRecord>,
) {
	const r = playlistRow(db, id);
	if (!r) throw new Error("playlist_not_found");
	const value = { ...playlistRecordOf(r), ...change, updatedAt: Date.now() };
	db.query("UPDATE music_playlists SET record_json=? WHERE id=?").run(
		JSON.stringify(value),
		id,
	);
	return value;
}
export function playlists(db: Database, conversationId: string) {
	return (
		db
			.query(
				"SELECT record_json FROM music_playlists WHERE conversation_id=? ORDER BY rowid DESC LIMIT 8",
			)
			.all(conversationId) as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as PlaylistRecord);
}

/** Completed playlists of every conversation, newest first. */
export function completedPlaylists(db: Database) {
	return (
		db
			.query(
				"SELECT record_json FROM music_playlists WHERE json_extract(record_json,'$.state')='completed' ORDER BY rowid DESC",
			)
			.all() as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as PlaylistRecord);
}
