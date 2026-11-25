import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { musicLibraryFixture, playbackQuestion } from "./music-library.fixture";
import { settle } from "../../infrastructure/wait-for";
import {
	ask,
	assignmentAgenda,
	cancelAssignment,
	ended,
	notes,
	plannedBy,
	reportLine,
	until,
} from "./assignment.fixture";
const agenda = (
	f: ReturnType<typeof musicLibraryFixture>,
	gateway: typeof f.gateway = f.gateway,
) =>
	assignmentAgenda({
		harness: {
			model: plannedBy({ library: f }),
			musicGateway: gateway,
		},
	});
const token = "Bearer fixture-token-for-toolchain-browser";
test("playback planning corrects model JSON before the library request", async () => {
	const f = musicLibraryFixture(true);
	const a = await agenda(f);
	try {
		await a.start();
		await ask(a, "music.library", playbackQuestion);
		await until(a, () => ended(a));
		expect(a.h.music!.playback.list("ao")[0]).toMatchObject({
			state: "completed",
			query: { tags: ["明るい", "ピアノ"] },
		});
		expect(f.stages).toEqual(["plan"]);
	} finally {
		await a.close();
	}
});
test("playback package routes through planning, saved references, parent answer and authenticated Range relay", async () => {
	const f = musicLibraryFixture(),
		a = await agenda(f),
		h = a.h;
	try {
		await a.start();
		const { source } = await ask(a, "music.library", playbackQuestion);
		await until(a, () => ended(a));
		const list = await (
			await h.request("/api/music/playlists?conversationId=ao")
		).json();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			kind: "playlist",
			state: "completed",
			query: { tags: ["明るい", "ピアノ"] },
			trackIds: ["two", "one"],
		});
		// The playlist is the work of the user's words, and the agent reports it on its own.
		expect(list[0]).toMatchObject({ runId: source.runId });
		await until(a, () => !!reportLine(a));
		expect(notes(a)).toHaveLength(1);
		expect(f.stages).toEqual(["plan"]);
		expect(await (await h.request("/api/music")).json()).toEqual([]);
		expect(
			f.requests.every(
				(r) => r.method === "GET" && r.path.startsWith("/v1/music/"),
			),
		).toBe(true);
		expect(f.requests.every((r) => r.auth === "Bearer control-fixture")).toBe(
			true,
		);
		expect((await h.app.request("/api/music/tracks/two/audio")).status).toBe(
			401,
		);
		const audio = await h.app.request("/api/music/tracks/two/audio", {
			headers: { authorization: token, Range: "bytes=64-127" },
		});
		expect(audio.status).toBe(206);
		expect(audio.headers.get("Content-Range")).toBe(
			`bytes 64-127/${f.audio.length}`,
		);
		expect(audio.headers.get("Accept-Ranges")).toBe("bytes");
		expect(audio.headers.get("Content-Type")).toContain("audio/ogg");
		expect(new Uint8Array(await audio.arrayBuffer())).toEqual(
			f.audio.subarray(64, 128),
		);
		expect(f.requests.at(-1)?.range).toBe("bytes=64-127");
		const bad = await h.app.request("/api/music/tracks/two/audio", {
			headers: { authorization: token, Range: "bytes=99999-" },
		});
		expect(bad.status).toBe(416);
		expect(bad.headers.get("Content-Range")).toBe(`bytes */${f.audio.length}`);
	} finally {
		await a.close();
	}
});
test("library pagination retains AND tags and sort; favorite, removal, global tags and contract errors are distinct", async () => {
	const f = musicLibraryFixture(),
		h = await harness({ model: f.model, musicGateway: f.gateway });
	const request = (path: string, method = "GET") =>
		h.app.request(path, { method, headers: { authorization: token } });
	try {
		const query = new URLSearchParams({
			tags: "明るい,ピアノ",
			sort: "createdAt",
			order: "asc",
			limit: "1",
		});
		const first = await (await request(`/api/music/tracks?${query}`)).json();
		expect(first.tracks[0].id).toBe("one");
		expect(first.total).toBe(2);
		expect(first.nextCursor).toBe("1");
		query.set("cursor", first.nextCursor);
		const second = await (await request(`/api/music/tracks?${query}`)).json();
		expect(second.tracks[0].id).toBe("two");
		expect(second.nextCursor).toBeUndefined();
		expect((await request("/api/music/tracks?limit=101")).status).toBe(400);
		expect(
			(await request("/api/music/tracks/one/favorite", "PUT")).status,
		).toBe(204);
		expect(
			(
				await (
					await request(
						"/api/music/tracks?favorite=true&sort=createdAt&order=desc",
					)
				).json()
			).tracks.map((t: { id: string }) => t.id),
		).toEqual(["one"]);
		expect(
			(await request("/api/music/tracks/one/favorite", "DELETE")).status,
		).toBe(204);
		expect((await request("/api/music/tracks/one")).status).toBe(200);
		expect((await request("/api/music/tracks/one", "DELETE")).status).toBe(204);
		expect((await request("/api/music/tracks/one")).status).toBe(404);
		expect(
			(await (await request("/api/music/tags")).json()).tags[0].count,
		).toBe(2);
		f.setFailure(507);
		const full = await request("/api/music/tracks/two/favorite", "PUT");
		expect(full.status).toBe(507);
		expect(await full.json()).toEqual({
			error: "music_storage_full",
			message: "契約のエラー",
		});
		f.setFailure(409);
		expect((await request("/api/music/tracks/two", "DELETE")).status).toBe(409);
	} finally {
		await h.close();
	}
});
test("a cancelled playback assignment never adopts a late library response", async () => {
	const f = musicLibraryFixture();
	let started = false,
		release!: () => void;
	const gateway = () => {
		const g = f.gateway();
		return {
			...g,
			library: {
				...g.library,
				tracks: async (...args: Parameters<typeof g.library.tracks>) => {
					started = true;
					await new Promise<void>((res) => {
						release = res;
					});
					return g.library.tracks(args[0], AbortSignal.timeout(1000));
				},
			},
		};
	};
	const a = await agenda(f, gateway);
	try {
		await a.start();
		const { id } = await ask(a, "music.library", playbackQuestion);
		await until(a, () => started);
		expect(started).toBe(true);
		await cancelAssignment(a, id);
		release();
		await settle();
		await until(a, () => ended(a));
		expect(a.h.music!.playback.list("ao")[0]?.state).toBe("cancelled");
		expect(a.h.music!.playback.list("ao")[0]?.trackIds).toEqual([]);
		expect(notes(a)).toHaveLength(0);
		expect(f.stages).toEqual(["plan"]);
	} finally {
		release?.();
		await a.close();
	}
}, 30_000);
test("Bun streaming relay remains valid through Node HTTP proxies", async () => {
	const f = musicLibraryFixture(),
		h = await harness({ model: f.model, musicGateway: f.gateway });
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (r) => h.app.fetch(r),
	});
	try {
		const { request } = await import("node:http");
		const data = await new Promise<{
			status: number;
			range: string | undefined;
			bytes: number;
		}>((resolve, reject) => {
			const req = request(
				`http://127.0.0.1:${server.port}/api/music/tracks/one/audio`,
				{ headers: { Authorization: token, Range: "bytes=64-127" } },
				(response) => {
					let bytes = 0;
					response.on("data", (chunk) => {
						bytes += chunk.length;
					});
					response.on("end", () =>
						resolve({
							status: response.statusCode!,
							range: response.headers["content-range"] as string | undefined,
							bytes,
						}),
					);
					response.on("error", reject);
				},
			);
			req.on("error", reject);
			req.end();
		});
		expect(data).toEqual({
			status: 206,
			range: `bytes 64-127/${f.audio.length}`,
			bytes: 64,
		});
	} finally {
		server.stop(true);
		await h.close();
	}
});
