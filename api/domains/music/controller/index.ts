import { registerLibrary } from "./library";
import type { Hono } from "hono";
import type { MusicService } from "../service";
import { MusicArtworkError } from "../service/artwork";
export function registerMusic(app: Hono, s: MusicService) {
	registerLibrary(app, s);
	app.get("/api/music", (c) =>
		c.json(s.list(c.req.query("conversationId") ?? "main")),
	);
	app.get("/api/music/:id", (c) => {
		const r = s.get(c.req.param("id"));
		return r ? c.json(r) : c.json({ error: "not_found" }, 404);
	});
	app.get("/api/music/:id/audio", (c) => {
		const a = s.audio(c.req.param("id"));
		return a
			? new Response(new Uint8Array(a.bytes), {
					headers: {
						"Content-Type": a.mime,
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
					},
				})
			: c.json({ error: "music_audio_unavailable" }, 404);
	});
	app.post("/api/music/:id/artwork", async (c) => {
		try {
			return c.json(await s.requestArtwork(c.req.param("id")), 202);
		} catch (error) {
			if (error instanceof MusicArtworkError)
				return c.json({ error: error.code }, error.status);
			if (error instanceof Error && error.message === "queue_full")
				return c.json({ error: "queue_full" }, 503);
			throw error;
		}
	});
	app.get("/api/music/:id/artwork", (c) => {
		const a = s.artwork(c.req.param("id"));
		return a
			? new Response(new Uint8Array(a.bytes), {
					headers: {
						"Content-Type": a.mime,
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
					},
				})
			: c.json({ error: "music_artwork_unavailable" }, 404);
	});
}
