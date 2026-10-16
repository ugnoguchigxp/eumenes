import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { musicLibraryFixture, playbackQuestion } from "./music-library.fixture";
import { settle, waitFor } from "../../infrastructure/wait-for";
const token = "Bearer fixture-token-for-toolchain-browser";
test("playback planning corrects model JSON before the library request", async () => {
	const f = musicLibraryFixture(true);
	const h = await harness({ model: f.model, musicGateway: f.gateway });
	try {
		const run = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: playbackQuestion,
			})
		).json();
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(h.music!.playback.list("main")[0]).toMatchObject({
			state: "completed",
			query: { tags: ["明るい", "ピアノ"] },
		});
		expect(f.stages).toEqual(["route", "plan", "answer"]);
	} finally {
		await h.close();
	}
});
test("playback package routes through planning, saved references, parent answer and authenticated Range relay", async () => {
	const f = musicLibraryFixture(),
		h = await harness({ model: f.model, musicGateway: f.gateway });
	try {
		const run = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: playbackQuestion,
			})
		).json();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		const list = await (
			await h.request("/api/music/playlists?conversationId=main")
		).json();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			kind: "playlist",
			state: "completed",
			query: { tags: ["明るい", "ピアノ"] },
			trackIds: ["two", "one"],
		});
		expect(f.stages).toEqual(["route", "plan", "answer"]);
		expect(h.dialogue.answerText(run.id)).toBe(
			"保存曲のプレイリストを開きました。",
		);
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
		await h.close();
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
test("cancelled playback never adopts a late library response", async () => {
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
	const h = await harness({ model: f.model, musicGateway: gateway });
	try {
		const r = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: playbackQuestion,
			})
		).json();
		await waitFor(() => !!started);
		expect(started).toBe(true);
		await h.dialogue.cancel(r.id);
		release();
		await settle();
		expect(h.music!.playback.list("main")[0]?.state).toBe("cancelled");
		expect(h.music!.playback.list("main")[0]?.trackIds).toEqual([]);
		expect(h.dialogue.get(r.id)?.status).toBe("cancelled");
		expect(f.stages).toEqual(["route", "plan"]);
	} finally {
		release?.();
		await h.close();
	}
});
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
