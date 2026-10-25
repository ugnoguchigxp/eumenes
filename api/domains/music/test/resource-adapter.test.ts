import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { MusicLibraryError, type LarmPlayground } from "../../larm";
import { migrations as queueMigrations } from "../../queue";
import { migrations, createMusicResourceAdapters } from "..";
import type { MusicRecord, PlaylistRecord } from "../contracts";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type LibraryTrack = {
	id: string;
	title: string;
	tags: string[];
	prompt: string;
	instrumental: boolean;
	durationSeconds: number;
	createdAt: string;
};
function setup(library: LibraryTrack[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-music-resource-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		...queueMigrations,
		...migrations,
	]);
	stores.push(store);
	const queries: unknown[] = [];
	const gateway = {
		library: {
			tracks: async (query: unknown) => {
				queries.push(query);
				return { tracks: library, total: library.length };
			},
			detail: async (id: string) => {
				const found = library.find((t) => t.id === id);
				if (!found) throw new MusicLibraryError(404, "larm_http_404", "none");
				return found;
			},
		},
	} as unknown as LarmPlayground;
	const [track, playlist] = createMusicResourceAdapters({
		store,
		gateway: () => gateway,
	});
	return { store, track: track!, playlist: playlist!, queries };
}
let serial = 0;
async function insertTrack(
	store: SqliteStore,
	change: Partial<MusicRecord> & { createdAt: number },
) {
	const id = crypto.randomUUID();
	const record: MusicRecord = {
		id,
		runId: `run-${serial++}`,
		conversationId: "main",
		state: "completed",
		title: "雨の本",
		description: "静かな雨",
		prompt: "soft piano, rain",
		durationSeconds: 45,
		phase: "completed",
		jobId: `music_${serial}`,
		errorCode: null,
		mime: "audio/mpeg",
		actualModel: null,
		updatedAt: change.createdAt,
		...change,
	};
	await store.write((db) =>
		db
			.query(
				"INSERT INTO music_generations(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline) VALUES(?,?,?,?,?,?,?)",
			)
			.run(id, record.runId, "main", JSON.stringify(record), "{}", "{}", 0),
	);
	return record;
}
async function insertPlaylist(
	store: SqliteStore,
	change: Partial<PlaylistRecord> & { createdAt: number },
) {
	const id = crypto.randomUUID();
	const record: PlaylistRecord = {
		kind: "playlist",
		id,
		runId: `run-${serial++}`,
		conversationId: "main",
		state: "completed",
		title: "雨の曲",
		query: { q: "", tags: [], sort: "createdAt", order: "desc", limit: 50 },
		trackIds: ["a", "b"],
		currentId: "a",
		errorCode: null,
		updatedAt: change.createdAt,
		...change,
	};
	await store.write((db) =>
		db
			.query(
				"INSERT INTO music_playlists(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline) VALUES(?,?,?,?,?,?,?)",
			)
			.run(id, record.runId, "main", JSON.stringify(record), "{}", "{}", 0),
	);
	return record;
}
const signal = new AbortController().signal;
const libraryTrack = (
	id: string,
	createdAt: string,
	title = id,
): LibraryTrack => ({
	id,
	title,
	tags: ["calm", "piano"],
	prompt: "soft piano",
	instrumental: true,
	durationSeconds: 30.4,
	createdAt,
});

test("a completed music.create result maps to one track reference", async () => {
	const { store, track } = setup();
	const done = await insertTrack(store, {
		createdAt: Date.UTC(2026, 9, 1),
		jobId: "music_abc",
	});
	const failed = await insertTrack(store, {
		createdAt: 2,
		state: "failed",
		jobId: null,
	});
	store.read((db) => {
		expect(
			track.fromResultInTransaction(db, done, { conversationId: "main" }),
		).toEqual([
			{
				uri: "eumenes://music.track/music_abc",
				kind: "music.track",
				label: "雨の本",
				createdAt: "2026-10-01T00:00:00.000Z",
			},
		]);
		expect(
			track.fromResultInTransaction(
				db,
				{ ...done, state: "generating" },
				{ conversationId: "main" },
			),
		).toEqual([]);
		expect(
			track.fromResultInTransaction(db, failed, { conversationId: "main" }),
		).toEqual([]);
		expect(
			track.fromResultInTransaction(
				db,
				{
					state: "completed",
					id: "x",
					jobId: "music_missing",
				},
				{ conversationId: "main" },
			),
		).toEqual([]);
	});
});

test("get resolves a local track to the music screen and misses others", async () => {
	const { store, track } = setup();
	const done = await insertTrack(store, { createdAt: 1, jobId: "music_abc" });
	await insertTrack(store, {
		createdAt: 2,
		state: "failed",
		jobId: "music_bad",
	});
	store.read((db) => {
		expect(track.getInTransaction(db, "music_abc")).toMatchObject({
			adapterRef: "adapter:music-screen@1",
			targetRef: done.id,
			actions: ["play", "open", "read"],
		});
		expect(track.getInTransaction(db, "music_missing")).toBeNull();
		expect(track.getInTransaction(db, "music_bad")).toBeNull();
	});
});

test("track search uses the library newest first, filters the window and offers only tracks made here", async () => {
	const library = [
		libraryTrack("old", "2026-10-01T00:00:00.000Z"),
		libraryTrack("new", "2026-10-03T00:00:00.000Z"),
		libraryTrack("mid", "2026-10-02T00:00:00.000Z"),
		libraryTrack("elsewhere", "2026-10-04T00:00:00.000Z"),
	];
	const { store, track, queries } = setup(library);
	for (const jobId of ["old", "new", "mid"])
		await insertTrack(store, { createdAt: 1, jobId });
	const found = await track.search({ text: " rain ", limit: 2 }, signal);
	expect(found.map((r) => r.uri)).toEqual([
		"eumenes://music.track/new",
		"eumenes://music.track/mid",
	]);
	expect(queries[0]).toMatchObject({
		q: "rain",
		sort: "createdAt",
		order: "desc",
	});
	const window = await track.search(
		{
			text: "",
			since: "2026-10-02T00:00:00.000Z",
			until: "2026-10-02T12:00:00.000Z",
			limit: 10,
		},
		signal,
	);
	expect(window.map((r) => r.uri)).toEqual(["eumenes://music.track/mid"]);
});

test("track read gives title, request and tags within the bound", async () => {
	const long = {
		...libraryTrack("music_abc", "2026-10-01T00:00:00.000Z", "雨の本"),
		prompt: "あ".repeat(3000),
	};
	const { store, track } = setup([long]);
	await insertTrack(store, {
		createdAt: 1,
		jobId: "music_abc",
		lyrics: "い".repeat(3000),
	});
	const { text } = await track.read("music_abc", signal);
	expect(text).toContain("雨の本");
	expect(text).toContain("静かな雨");
	expect(estimateTextTokens(text)).toBeLessThanOrEqual(600);
	const short = await setup([
		libraryTrack("t", "2026-10-01T00:00:00.000Z", "夜"),
	]).track.read("t", signal);
	expect(short.text).toContain("タグ: calm、piano");
	await expect(setup().track.read("nope", signal)).rejects.toThrow(
		"item_not_found",
	);
});

test("playlist adapter maps, resolves, searches and reads", async () => {
	const { store, playlist } = setup([
		libraryTrack("b", "2026-10-01T00:00:00.000Z", "別の曲"),
	]);
	await insertTrack(store, { createdAt: 1, jobId: "a", title: "最初の曲" });
	const older = await insertPlaylist(store, {
		createdAt: Date.UTC(2026, 9, 1),
		title: "雨の曲",
	});
	const newer = await insertPlaylist(store, {
		createdAt: Date.UTC(2026, 9, 2),
		title: "晴れの雨",
	});
	const planning = await insertPlaylist(store, {
		createdAt: 3,
		state: "planning",
	});
	const empty = await insertPlaylist(store, {
		createdAt: 4,
		trackIds: [],
		title: "空",
	});
	store.read((db) => {
		expect(
			playlist.fromResultInTransaction(db, newer, { conversationId: "main" }),
		).toEqual([
			{
				uri: `eumenes://music.playlist/${newer.id}`,
				kind: "music.playlist",
				label: "晴れの雨",
				createdAt: "2026-10-02T00:00:00.000Z",
			},
		]);
		expect(
			playlist.fromResultInTransaction(db, planning, {
				conversationId: "main",
			}),
		).toEqual([]);
		expect(
			playlist.fromResultInTransaction(db, empty, { conversationId: "main" }),
		).toEqual([]);
		expect(
			playlist.fromResultInTransaction(
				db,
				{
					state: "completed",
					id: "x",
					jobId: "j",
				},
				{ conversationId: "main" },
			),
		).toEqual([]);
		expect(playlist.getInTransaction(db, older.id)).toMatchObject({
			adapterRef: "adapter:music-library@1",
			targetRef: older.id,
			actions: ["play", "open"],
		});
		expect(playlist.getInTransaction(db, planning.id)).toBeNull();
		expect(playlist.getInTransaction(db, "missing")).toBeNull();
	});
	const found = await playlist.search({ text: "雨", limit: 10 }, signal);
	expect(found.map((r) => r.uri)).toEqual([
		`eumenes://music.playlist/${newer.id}`,
		`eumenes://music.playlist/${older.id}`,
	]);
	const { text } = await playlist.read(older.id, signal);
	expect(text).toContain("雨の曲（2曲）");
	expect(text).toContain("1. 最初の曲");
	expect(text).toContain("2. 別の曲");
	await expect(playlist.read("missing", signal)).rejects.toThrow(
		"item_not_found",
	);
});
