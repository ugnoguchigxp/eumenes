import type { Hono } from "hono";
import { imageArtifactId } from "../../larm/contracts";
import type { ImageService } from "../service";
export function registerImage(app: Hono, s: ImageService) {
	app.delete("/api/images/:id", async (c) => {
		const id = imageArtifactId.safeParse(c.req.param("id"));
		if (!id.success) return c.json({ error: "invalid_image_id" }, 400);
		try {
			return c.json(
				await s
					.library()
					.remove(
						id.data,
						AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)]),
					),
				200,
				{ "Cache-Control": "no-store" },
			);
		} catch (error) {
			if (error instanceof Error && error.message === "larm_http_404")
				return c.json({ error: "image_not_found" }, 404);
			return c.json({ error: "image_delete_unconfirmed" }, 502);
		}
	});
	app.get("/api/images/generations", (c) =>
		c.json(s.list(c.req.query("conversationId") ?? "main")),
	);
	app.get("/api/images/library", async (c) => {
		try {
			return c.json(
				await s
					.library()
					.list(
						AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)]),
					),
			);
		} catch {
			return c.json({ error: "image_library_unavailable" }, 502);
		}
	});
	app.get("/api/images/:id/content", async (c) => {
		const id = imageArtifactId.safeParse(c.req.param("id"));
		if (!id.success) return c.json({ error: "invalid_image_id" }, 400);
		try {
			const a = await s.content(
				id.data,
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
			);
			return new Response(new Uint8Array(a.bytes!), {
				headers: {
					"Content-Type": a.mime!,
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
					"Content-Disposition": `inline; filename="image-${id.data}.${a.mime === "image/png" ? "png" : "webp"}"`,
				},
			});
		} catch {
			return c.json({ error: "image_content_unavailable" }, 502);
		}
	});
}
