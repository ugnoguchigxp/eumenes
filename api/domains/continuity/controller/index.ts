import type { Hono } from "hono";
import type { ContinuityService } from "..";
import { addContinuitySchema, continuityTransitionSchema } from "../contracts";
export function registerContinuity(app: Hono, service: ContinuityService) {
	app.get("/api/conversations/:id/continuity", (c) =>
		c.json({
			items: service.list(c.req.param("id"), c.req.query("all") === "1"),
		}),
	);
	app.post("/api/conversations/:id/continuity", async (c) => {
		const parsed = addContinuitySchema.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: "invalid_continuity" }, 400);
		return c.json(await service.add(c.req.param("id"), parsed.data), 201);
	});
	app.post("/api/continuity/:itemId/transition", async (c) => {
		const parsed = continuityTransitionSchema.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: "invalid_continuity" }, 400);
		return c.json(await service.transition(c.req.param("itemId"), parsed.data));
	});
}
