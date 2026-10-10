import type { Hono } from "hono";
import { parseJsonBody } from "../../../infrastructure/http";
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
		const parsed = await parseJsonBody(c, addContinuitySchema, {
			code: "invalid_continuity",
		});
		const id = conversationIdSchema.safeParse(c.req.param("id"));
		if (!parsed.ok) return parsed.response;
		if (!id.success) return c.json({ error: "invalid_continuity" }, 400);
		return c.json(await service.add(id.data, parsed.data), 201);
	});
	app.post("/api/continuity/:itemId/transition", async (c) => {
		const parsed = await parseJsonBody(c, continuityTransitionSchema, {
			code: "invalid_continuity",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(await service.transition(c.req.param("itemId"), parsed.data));
	});
}
