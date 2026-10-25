import type { Database } from "bun:sqlite";
import { trackQuery, type PlaylistRecord } from "../contracts";
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

const TRACK_PLAY_PREFIX = "resource-play:";
/** Playlists made for a resource `play` carry this run id; they are not part of the user's own list. */
const trackPlayRunId = (conversationId: string, trackId: string) =>
	`${TRACK_PLAY_PREFIX}${conversationId}:${trackId}`;

/**
 * The completed one-track playlist that plays `trackId` (no model call, no queue job). One row per conversation and track:
 * a repeated call resets that row to the track instead of adding another.
 */
export function ensureTrackPlaylist(
	db: Database,
	conversationId: string,
	trackId: string,
	title: string | null,
) {
	const runId = trackPlayRunId(conversationId, trackId);
	const existing = playlistByRun(db, runId);
	const state = {
		state: "completed" as const,
		query: trackQuery.parse({}),
		trackIds: [trackId],
		currentId: trackId,
		errorCode: null,
	};
	if (existing) {
		patchPlaylist(db, existing.id, {
			...state,
			...(title ? { title } : {}),
		});
		return existing.id;
	}
	const id = crypto.randomUUID();
	const now = Date.now();
	const view: PlaylistRecord = {
		kind: "playlist",
		id,
		runId,
		conversationId,
		title: title ?? "楽曲",
		createdAt: now,
		updatedAt: now,
		...state,
	};
	db.query(
		"INSERT INTO music_playlists(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline) VALUES(?,?,?,?,?,?,?)",
	).run(id, runId, conversationId, JSON.stringify(view), "{}", "{}", 0);
	return id;
}

/** Completed playlists of every conversation, newest first, without the one-track ones made for `play`. */
export function completedPlaylists(db: Database) {
	return (
		db
			.query(
				"SELECT record_json FROM music_playlists WHERE json_extract(record_json,'$.state')='completed' AND run_id NOT LIKE ? ORDER BY rowid DESC",
			)
			.all(`${TRACK_PLAY_PREFIX}%`) as { record_json: string }[]
	).map((r) => JSON.parse(r.record_json) as PlaylistRecord);
}
