import type { Hono } from "hono";
import { z } from "zod";
import type { ContinuityService } from "..";
import { addContinuitySchema, continuityTransitionSchema } from "../contracts";
const conversationIdSchema = z.string().min(1).max(120);
export function registerContinuity(app: Hono, service: ContinuityService) {
	app.get("/api/conversations/:id/continuity", (c) => {
		const id = conversationIdSchema.safeParse(c.req.param("id"));
		if (!id.success) return c.json({ error: "invalid_continuity" }, 400);
		return c.json({
			items: service.list(id.data, c.req.query("all") === "1"),
		});
	});
	app.post("/api/conversations/:id/continuity", async (c) => {
		const parsed = addContinuitySchema.safeParse(
			await c.req.json().catch(() => null),
		);
		const id = conversationIdSchema.safeParse(c.req.param("id"));
		if (!parsed.success || !id.success)
			return c.json({ error: "invalid_continuity" }, 400);
		return c.json(await service.add(id.data, parsed.data), 201);
	});
	app.post("/api/continuity/:itemId/transition", async (c) => {
		const parsed = continuityTransitionSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_continuity" }, 400);
		return c.json(await service.transition(c.req.param("itemId"), parsed.data));
	});
}
