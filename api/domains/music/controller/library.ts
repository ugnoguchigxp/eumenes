import { parseJsonBody, queryInt } from "../../../infrastructure/http";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Hono, Context } from "hono";
import { z } from "zod";
import { MusicLibraryError, trackQuery } from "../../larm";
import { playlistUpdate } from "../contracts";
import type { MusicService } from "../service";
export function registerLibrary(app: Hono, s: MusicService) {
	const handle = async (c: Context, fn: () => Promise<Response>) => {
		try {
			return await fn();
		} catch (error) {
			if (error instanceof MusicLibraryError)
				return c.json(
					{ error: error.code, message: error.detail },
					error.status as ContentfulStatusCode,
				);
			if (error instanceof z.ZodError)
				return c.json(
					{
						error: "invalid_music_contract",
						message: "検索条件または楽曲の応答を確認してください。",
					},
					400,
				);
			throw error;
		}
	};
	app.get("/api/music/tracks", (c) =>
		handle(c, async () => {
			const p = c.req.query();
			const query = trackQuery.parse({
				...p,
				...(p.tags ? { tags: p.tags.split(",") } : {}),
				...(p.limit ? { limit: queryInt.parse(p.limit) } : {}),
				...(p.favorite
					? { favorite: z.enum(["true", "false"]).parse(p.favorite) === "true" }
					: {}),
			});
			return c.json(await s.library().tracks(query, c.req.raw.signal));
		}),
	);
	app.get("/api/music/tags", (c) =>
		handle(c, async () => c.json(await s.library().tags(c.req.raw.signal))),
	);
	app.get("/api/music/tracks/:id", (c) =>
		handle(c, async () =>
			c.json(await s.library().detail(c.req.param("id"), c.req.raw.signal)),
		),
	);
	app.get("/api/music/tracks/:id/audio", (c) =>
		handle(c, () =>
			s
				.library()
				.audio(c.req.param("id"), c.req.header("Range"), c.req.raw.signal),
		),
	);
	app.get("/api/music/tracks/:id/generation", (c) => {
		const g = s.trackGeneration(c.req.param("id"));
		return g ? c.json(g) : c.json({ error: "music_generation_not_found" }, 404);
	});
	app.get("/api/music/tracks/:id/metadata", (c) =>
		handle(c, async () =>
			c.json(await s.library().metadata(c.req.param("id"), c.req.raw.signal)),
		),
	);
	for (const method of ["put", "delete"] as const)
		app[method]("/api/music/tracks/:id/favorite", (c) =>
			handle(c, async () => {
				await s
					.library()
					.favorite(c.req.param("id"), method === "put", c.req.raw.signal);
				return c.body(null, 204);
			}),
		);
	app.delete("/api/music/tracks/:id", (c) =>
		handle(c, async () => {
			await s.library().remove(c.req.param("id"), c.req.raw.signal);
			return c.body(null, 204);
		}),
	);
	app.get("/api/music/playlists", (c) =>
		c.json(s.playback.list(c.req.query("conversationId") ?? "main")),
	);
	app.get("/api/music/playlists/:id", (c) => {
		const p = s.playback.get(c.req.param("id"));
		return p ? c.json(p) : c.json({ error: "playlist_not_found" }, 404);
	});
	app.put("/api/music/playlists/:id", (c) =>
		handle(c, async () => {
			const parsed = await parseJsonBody(c, playlistUpdate);
			if (!parsed.ok) return parsed.response;
			const p = await s.playback.update(c.req.param("id"), parsed.data);
			return p ? c.json(p) : c.json({ error: "playlist_not_found" }, 404);
		}),
	);
}
