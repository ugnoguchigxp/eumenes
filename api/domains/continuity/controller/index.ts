import type { Hono } from "hono";
import { z } from "zod";
import type { ContinuityService } from "..";
const conversationIdSchema = z.string().min(1).max(120);
/** Notes are read-only over HTTP: the steward writes them, nobody changes them by hand. */
export function registerContinuity(app: Hono, service: ContinuityService) {
	app.get("/api/conversations/:id/continuity", (c) => {
		const id = conversationIdSchema.safeParse(c.req.param("id"));
		if (!id.success) return c.json({ error: "invalid_continuity" }, 400);
		return c.json({
			items: service.list(id.data, c.req.query("all") === "1"),
		});
	});
}
