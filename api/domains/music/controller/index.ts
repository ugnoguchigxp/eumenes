import { registerLibrary } from "./library";
import type { Hono } from "hono";
import type { MusicService } from "../service";
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
}
