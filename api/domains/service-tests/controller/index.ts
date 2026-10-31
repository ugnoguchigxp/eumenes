import { readBounded } from "../../../infrastructure/bounded-read";
import type { Hono } from "hono";
import type { ServiceTests } from "../service";
function bounded(request: Request, limit: number) {
	return readBounded(request.body, {
		limit,
		tooLarge: "invalid_body_size",
		missing: "invalid_body",
	});
}
export function registerServiceTests(app: Hono, s: ServiceTests) {
	app.post("/api/service-tests/uploads", async (c) =>
		c.json(s.upload(await bounded(c.req.raw, 4_000_000)), 201),
	);
	app.get("/api/service-tests/runs/:id/artifact", (c) => {
		const p = s.preview(c.req.param("id"));
		if (!p?.bytes || !p.mime) return c.json({ error: "preview_expired" }, 410);
		return new Response(new Uint8Array(p.bytes), {
			headers: {
				"Content-Type": p.mime,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});
}
