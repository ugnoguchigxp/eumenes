import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import type { Capabilities, Prepared } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { LarmPlayground, LarmTestTarget } from "../../larm";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { MusicLibraryError } from "../../larm";
import { migrations, registerMusic } from "..";
import { createMusic, musicListInTransaction } from "../service";

const prepared = {
	package: {
		kind: "package",
		id: "music.create",
		revision: 2,
		profileRevisionId: "profile:music.fake@1",
		requiredSkillRevisionIds: ["skill:music.fake@1"],
	},
	dependencies: [
		{ revisionId: "profile:music.fake@1", kind: "profile", body: "担当" },
		{ revisionId: "skill:music.fake@1", kind: "skill", body: "手順" },
	],
} as unknown as Prepared;
const plan = {
	title: "雨の本",
	description: "静かな雨",
	prompt: "soft piano, rain",
	durationSeconds: 45,
	instrumental: true,
};
const playbackPlan = {
	title: "雨の曲",
	q: "rain",
	tags: ["calm"],
	favorite: null,
	sort: "createdAt",
	order: "desc",
};
const target = (capability: string, protocol = "fake.v1"): LarmTestTarget => ({
	id: capability,
	name: capability,
	model: "fake-model",
	capability,
	protocol,
	kind: capability.includes("image") ? "image" : "music",
	mode: "service",
	endpoint: "http://fake",
	profile: "fake",
	revision: "1",
	onDemand: false,
	primary: true,
	description: "fake service",
});
const musicTarget = target("media.music.generate");
const imageTarget = target("media.image.generate", "larm.image-generation.v1");

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function until(cond: () => boolean) {
	for (let i = 0; i < 400; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not reached");
}

type Options = {
	planValue?: string;
	playbackValue?: string;
	targets?: LarmTestTarget[];
	audio?: { bytes?: Uint8Array; mime?: string };
	validate?: () => void;
	accept?: boolean;
	artwork?: { bytes?: Uint8Array; mime?: string };
	trackIds?: string[];
};
function setup(options: Options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-music-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		...queueMigrations,
		...migrations,
	]);
	stores.push(store);
	const queue = createQueue(store);
	const executed: Array<Record<string, unknown>> = [];
	const removed: string[] = [];
	const trackQueries: unknown[] = [];
	const jobs: Array<[string, string]> = [];
	const finished: string[] = [];
	let nextValue = options.planValue;
	const inference = {
		captureControlInTransaction: () => "request-1",
		executeControl: async (
			_id: string,
			messages: Array<{ content: string }>,
		) => {
			const wantsPlayback = messages[1]!.content.includes("libraryTags");
			return {
				requestId: "request-1",
				attemptId: "attempt-1",
				value: wantsPlayback
					? (options.playbackValue ?? JSON.stringify(playbackPlan))
					: (nextValue ?? JSON.stringify(plan)),
			};
		},
		acceptInTransaction: () => options.accept ?? true,
	} as unknown as InferencePort;
	const capabilities = {
		prepareActiveByIdInTransaction: () => prepared,
		validateInTransaction: () => options.validate?.(),
	} as unknown as Capabilities;
	const gateway = {
		catalog: async () => ({
			targets: options.targets ?? [musicTarget, imageTarget],
		}),
		execute: async (
			t: LarmTestTarget,
			input: Record<string, unknown>,
			_s: unknown,
			p: (v: unknown) => Promise<void>,
		) => {
			executed.push(input);
			if (t.capability === "media.image.generate")
				return {
					bytes: options.artwork?.bytes ?? new Uint8Array([7, 7]),
					mime: options.artwork?.mime ?? "image/png",
					artifact: { id: "cover-1", path: "/a", mime: "image/png" },
				};
			await p({ phase: "generating", jobId: "job-77" });
			return {
				bytes: options.audio?.bytes ?? new Uint8Array([1, 2, 3, 4]),
				mime: options.audio?.mime ?? "audio/mpeg",
				actualModel: "fake-actual",
			};
		},
		images: {
			remove: async (id: string) => {
				removed.push(id);
				return { id, deleted: true };
			},
		},
		library: {
			tags: async () => ({ tags: [{ tag: "calm", count: 2 }] }),
			tracks: async (query: unknown) => {
				trackQueries.push(query);
				return {
					tracks: (options.trackIds ?? ["t1", "t2"]).map((id) => ({ id })),
				};
			},
			detail: async (id: string) => {
				if (id === "unknown") throw new Error("larm_http_404");
				return { id };
			},
		},
	} as unknown as LarmPlayground;
	const music = createMusic({
		store,
		queue,
		inference,
		capabilities,
		gateway: () => gateway,
		onJob: (_db, runId, jobId) => jobs.push([runId, jobId]),
		onFinished: (_db, runId) => finished.push(runId),
	});
	queue.start();
	const input = (runId: string, conversationId: string) => ({
		runId,
		conversationId,
		question: "雨の日の曲",
		originalRequest: "雨の日の曲",
		deadline: Date.now() + 120_000,
	});
	return {
		store,
		queue,
		music,
		executed,
		removed,
		trackQueries,
		jobs,
		finished,
		setPlan: (value: string) => (nextValue = value),
		start: (runId = "run-1", conversationId = "main") =>
			store.write((db) =>
				music.startInTransaction(db, input(runId, conversationId)),
			),
		startPlayback: (runId = "run-p", conversationId = "main") =>
			store.write((db) =>
				music.startPlaybackInTransaction(db, input(runId, conversationId)),
			),
	};
}
type Harness = ReturnType<typeof setup>;
const generationDone = (h: Harness, id: string) => () => {
	const state = h.music.get(id)?.state;
	return state !== "planning" && state !== "generating";
};
const playlistDone = (h: Harness, id: string) => () =>
	h.music.playback.get(id)?.state !== "planning";
const artworkDone = (h: Harness, id: string) => () => {
	const state = h.music.get(id)?.artwork?.state;
	return state !== undefined && state !== "generating";
};
const completed = async (h: Harness, runId = "run-1") => {
	const { id } = await h.start(runId);
	await until(generationDone(h, id));
	return id;
};

test("start is idempotent per run and records one plan job", async () => {
	const h = setup();
	const first = await h.start();
	expect(await h.start()).toEqual(first);
	expect(h.jobs).toEqual([["run-1", first.jobId]]);
	expect(h.music.get(first.id)).toMatchObject({
		state: "planning",
		prompt: null,
		durationSeconds: null,
		jobId: null,
	});
	await h.queue.close(100);
});

test("plan then generate stores the audio and exposes it only when completed", async () => {
	const h = setup();
	const { id } = await h.start();
	expect(h.music.audio(id)).toBeNull();
	await until(generationDone(h, id));
	expect(h.music.get(id)).toMatchObject({
		state: "completed",
		phase: "completed",
		title: "雨の本",
		prompt: "soft piano, rain",
		durationSeconds: 45,
		instrumental: true,
		jobId: "job-77",
		mime: "audio/mpeg",
		actualModel: "fake-actual",
	});
	expect(h.executed).toEqual([
		{
			text: "soft piano, rain",
			durationSeconds: 45,
			instrumental: true,
			lyrics: undefined,
			language: undefined,
		},
	]);
	expect(h.music.audio(id)).toEqual({
		bytes: new Uint8Array([1, 2, 3, 4]),
		mime: "audio/mpeg",
	});
	expect(h.music.audio("missing")).toBeNull();
	expect(h.finished).toEqual(["run-1"]);
	expect(
		h.store.read((db) => h.music.resultInTransaction(db, "run-1")),
	).toEqual(h.music.get(id));
	expect(
		h.store.read((db) => h.music.resultInTransaction(db, "none")),
	).toBeNull();
	await h.queue.close(100);
});

test("a vocal plan passes its lyrics and language to the generation service", async () => {
	const vocal = setup({
		planValue: JSON.stringify({
			...plan,
			instrumental: false,
			lyrics: "la la",
			language: "ja",
		}),
	});
	const a = await vocal.start();
	await until(generationDone(vocal, a.id));
	expect(vocal.executed[0]).toMatchObject({
		instrumental: false,
		lyrics: "la la",
		language: "ja",
	});
	await vocal.queue.close(100);
});

test("an invalid plan or generation result fails the record with a stable code", async () => {
	const cases: Array<[Options, string]> = [
		[{ planValue: "not json" }, "music_plan_invalid_json"],
		[
			{ planValue: JSON.stringify({ ...plan, durationSeconds: 601 }) },
			"music_plan_invalid_contract",
		],
		[{ targets: [] }, "music_service_unavailable"],
		[{ audio: { mime: "image/png" } }, "music_audio_missing"],
		[{ audio: { bytes: new Uint8Array() } }, "music_audio_missing"],
		[
			{ audio: { bytes: new Uint8Array(32 * 1024 * 1024 + 1) } },
			"music_audio_too_large",
		],
		[{ accept: false }, "music_plan_invalidated"],
	];
	for (const [options, code] of cases) {
		const h = setup(options);
		const { id } = await h.start();
		await until(generationDone(h, id));
		expect(h.music.get(id)).toMatchObject({
			state: "failed",
			phase: "failed",
			errorCode: code,
		});
		expect(h.music.audio(id)).toBeNull();
		expect(h.finished).toEqual(["run-1"]);
		await h.queue.close(100);
	}
});

test("a revoked capability fails the record", async () => {
	const h = setup({
		validate: () => {
			throw new Error("capability_unavailable");
		},
	});
	const { id } = await h.start();
	await until(generationDone(h, id));
	expect(h.music.get(id)?.state).toBe("failed");
	expect(h.executed).toEqual([]);
	await h.queue.close(100);
});

test("list is scoped to the conversation, newest first and limited to eight", async () => {
	const h = setup({ targets: [] });
	const ids: string[] = [];
	for (let i = 0; i < 10; i++) ids.push((await h.start(`run-${i}`, "one")).id);
	await h.start("other", "two");
	expect(h.music.list("one").map((r) => r.id)).toEqual(ids.slice(2).reverse());
	expect(
		h.store.read((db) => musicListInTransaction(db, "two")).map((r) => r.runId),
	).toEqual(["other"]);
	await h.queue.close(100);
});

test("a library track resolves to the generation that produced it", async () => {
	const h = setup();
	const id = await completed(h);
	expect(h.music.trackGeneration("job-77")).toEqual({ id });
	expect(h.music.trackGeneration("other-track")).toBeNull();
	await h.queue.close(100);
});

test("playback builds a playlist from the library query and selects the first track", async () => {
	const h = setup();
	const { id } = await h.startPlayback();
	expect(h.music.playback.get(id)?.state).toBe("planning");
	await until(playlistDone(h, id));
	expect(h.music.playback.get(id)).toMatchObject({
		kind: "playlist",
		state: "completed",
		title: "雨の曲",
		trackIds: ["t1", "t2"],
		currentId: "t1",
		query: { q: "rain", tags: ["calm"], sort: "createdAt", order: "desc" },
	});
	expect(h.trackQueries).toHaveLength(1);
	expect(h.trackQueries[0]).not.toHaveProperty("favorite");
	expect(h.finished).toEqual(["run-p"]);
	expect(h.music.playback.list("main")).toHaveLength(1);
	expect(h.music.playback.list("none")).toEqual([]);
	expect(
		h.store.read((db) => h.music.playback.resultInTransaction(db, "run-p")),
	).toEqual(h.music.playback.get(id)!);
	// A playback run is also visible through the generic result lookup.
	expect(
		h.store.read((db) => h.music.resultInTransaction(db, "run-p")),
	).toEqual(h.music.playback.get(id)!);
	expect(await h.startPlayback()).toEqual({ id, jobId: expect.any(String) });
	await h.queue.close(100);
});

test("an empty library result completes with no current track", async () => {
	const h = setup({ trackIds: [] });
	const { id } = await h.startPlayback();
	await until(playlistDone(h, id));
	expect(h.music.playback.get(id)).toMatchObject({
		state: "completed",
		trackIds: [],
		currentId: null,
	});
	await h.queue.close(100);
});

test("an invalid playback plan fails the playlist", async () => {
	for (const [playbackValue, code] of [
		["nope", "music_playback_invalid_json"],
		[
			JSON.stringify({ ...playbackPlan, sort: "random" }),
			"music_playback_invalid_contract",
		],
	] as const) {
		const h = setup({ playbackValue });
		const { id } = await h.startPlayback();
		await until(playlistDone(h, id));
		expect(h.music.playback.get(id)).toMatchObject({
			state: "failed",
			errorCode: code,
		});
		await h.queue.close(100);
	}
});

test("a playlist update validates the selected track and resets the selection on a new query", async () => {
	const h = setup();
	expect(
		await h.music.playback.update("missing", { currentId: "t2" }),
	).toBeNull();
	const { id } = await h.startPlayback();
	await expect(
		h.music.playback.update(id, { currentId: "t2" }),
	).rejects.toThrow("playlist_not_completed");
	await until(playlistDone(h, id));
	const picked = await h.music.playback.update(id, { currentId: "t2" });
	expect(picked).toMatchObject({ currentId: "t2", trackIds: ["t1", "t2"] });
	await expect(
		h.music.playback.update(id, { currentId: "unknown" }),
	).rejects.toThrow("larm_http_404");
	expect(h.music.playback.get(id)?.currentId).toBe("t2");
	const requery = await h.music.playback.update(id, {
		query: { q: "jazz", tags: [], sort: "relevance", order: "asc", limit: 20 },
	});
	expect(requery).toMatchObject({ trackIds: [], currentId: null });
	expect(requery?.query.q).toBe("jazz");
	await h.queue.close(100);
});

test("artwork can be requested only for a completed track and is stored by revision", async () => {
	const h = setup();
	await expect(h.music.requestArtwork("missing")).rejects.toMatchObject({
		code: "music_not_found",
		status: 404,
	});
	const planning = await h.start("run-plan");
	await expect(h.music.requestArtwork(planning.id)).rejects.toMatchObject({
		code: "music_not_completed",
		status: 409,
	});
	await until(generationDone(h, planning.id));
	expect(h.music.artwork(planning.id)).toBeNull();
	const started = await h.music.requestArtwork(planning.id);
	expect(started.artwork).toEqual({
		state: "generating",
		revision: 1,
		errorCode: null,
	});
	await until(artworkDone(h, planning.id));
	expect(h.music.get(planning.id)?.artwork).toEqual({
		state: "completed",
		revision: 1,
		errorCode: null,
	});
	expect(h.music.artwork(planning.id)).toEqual({
		bytes: new Uint8Array([7, 7]),
		mime: "image/png",
	});
	// The studio library must not keep the track's cover.
	expect(h.removed).toEqual(["cover-1"]);
	const prompt = String(h.executed.at(-1)!.text);
	expect(prompt).toContain("雨の本");
	expect(prompt).toContain("soft piano, rain");
	const again = await h.music.requestArtwork(planning.id);
	expect(again.artwork?.revision).toBe(2);
	await until(artworkDone(h, planning.id));
	await h.queue.close(100);
});

test("artwork failures are recorded without disturbing the track", async () => {
	const h = setup({ artwork: { mime: "text/plain" } });
	const id = await completed(h);
	await h.music.requestArtwork(id);
	await until(artworkDone(h, id));
	expect(h.music.get(id)).toMatchObject({
		state: "completed",
		artwork: { state: "failed", errorCode: "music_artwork_missing" },
	});
	expect(h.music.artwork(id)).toBeNull();
	expect(h.music.audio(id)).not.toBeNull();
	await h.queue.close(100);
});

test("music routes serve records, audio and artwork and report missing media", async () => {
	const h = setup();
	const app = new Hono();
	registerMusic(app, h.music);
	const id = await completed(h);
	expect((await app.request("/api/music/nope")).status).toBe(404);
	expect(await (await app.request(`/api/music/${id}`)).json()).toMatchObject({
		id,
		state: "completed",
	});
	expect(
		(
			(await (
				await app.request("/api/music?conversationId=main")
			).json()) as unknown[]
		).length,
	).toBe(1);
	const audio = await app.request(`/api/music/${id}/audio`);
	expect(audio.headers.get("content-type")).toBe("audio/mpeg");
	expect(audio.headers.get("x-content-type-options")).toBe("nosniff");
	expect(new Uint8Array(await audio.arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3, 4]),
	);
	expect((await app.request("/api/music/nope/audio")).status).toBe(404);
	expect((await app.request(`/api/music/${id}/artwork`)).status).toBe(404);
	expect(
		(await app.request("/api/music/nope/artwork", { method: "POST" })).status,
	).toBe(404);
	const requested = await app.request(`/api/music/${id}/artwork`, {
		method: "POST",
	});
	expect(requested.status).toBe(202);
	await until(artworkDone(h, id));
	const cover = await app.request(`/api/music/${id}/artwork`);
	expect(cover.status).toBe(200);
	expect(cover.headers.get("content-type")).toBe("image/png");
	await h.queue.close(100);
});

test("library routes validate input and map library errors", async () => {
	const h = setup();
	const calls: unknown[][] = [];
	const failing = new MusicLibraryError(404, "track_not_found", "なし");
	const library = {
		tracks: async (query: unknown) => {
			calls.push(["tracks", query]);
			return { tracks: [], nextCursor: null };
		},
		tags: async () => ({ tags: [] }),
		detail: async (id: string) => {
			if (id === "gone") throw failing;
			return { id };
		},
		favorite: async (id: string, value: boolean) => {
			calls.push(["favorite", id, value]);
		},
		remove: async (id: string) => {
			calls.push(["remove", id]);
		},
		metadata: async (id: string) => ({ id }),
		audio: async () => new Response("pcm", { status: 206 }),
	};
	const app = new Hono();
	registerMusic(app, { ...h.music, library: () => library } as never);
	const ok = await app.request(
		"/api/music/tracks?q=rain&tags=a,b&limit=5&favorite=true",
	);
	expect(ok.status).toBe(200);
	expect(calls[0]![1]).toMatchObject({
		q: "rain",
		tags: ["a", "b"],
		limit: 5,
		favorite: true,
	});
	const bad = await app.request("/api/music/tracks?favorite=maybe");
	expect(bad.status).toBe(400);
	expect(await bad.json()).toMatchObject({ error: "invalid_music_contract" });
	const missing = await app.request("/api/music/tracks/gone");
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({
		error: "track_not_found",
		message: "なし",
	});
	expect(
		(await app.request("/api/music/tracks/t1/favorite", { method: "PUT" }))
			.status,
	).toBe(204);
	expect(
		(await app.request("/api/music/tracks/t1/favorite", { method: "DELETE" }))
			.status,
	).toBe(204);
	expect(
		(await app.request("/api/music/tracks/t1", { method: "DELETE" })).status,
	).toBe(204);
	expect(calls.slice(1)).toEqual([
		["favorite", "t1", true],
		["favorite", "t1", false],
		["remove", "t1"],
	]);
	expect((await app.request("/api/music/tracks/t1/audio")).status).toBe(206);
	expect((await app.request("/api/music/tracks/t9/generation")).status).toBe(
		404,
	);
	await h.queue.close(100);
});

test("playlist routes return stored playlists and validate updates", async () => {
	const h = setup();
	const app = new Hono();
	registerMusic(app, h.music);
	const { id } = await h.startPlayback();
	await until(playlistDone(h, id));
	expect((await app.request("/api/music/playlists/nope")).status).toBe(404);
	expect(
		await (await app.request(`/api/music/playlists/${id}`)).json(),
	).toMatchObject({ id, currentId: "t1" });
	expect(
		((await (await app.request("/api/music/playlists")).json()) as unknown[])
			.length,
	).toBe(1);
	const put = (target: string, body: unknown) =>
		app.request(`/api/music/playlists/${target}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	expect((await put(id, { unexpected: true })).status).toBe(400);
	expect((await put("nope", { currentId: "t2" })).status).toBe(404);
	const updated = await put(id, { currentId: "t2" });
	expect(await updated.json()).toMatchObject({ currentId: "t2" });
	await h.queue.close(100);
});
