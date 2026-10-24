import type { Hono } from "hono";
import { decisionsQuerySchema, eventsQuerySchema } from "../contracts";
import type { StewardService } from "../service";

/** Read-only: what the steward decided, and the event log it works from. */
export function registerSteward(app: Hono, service: StewardService) {
	app.get("/api/steward/decisions", (c) => {
		const parsed = decisionsQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw new Error("invalid_steward_input");
		return c.json({
			items: service.decisions(parsed.data.conversationId, parsed.data.limit),
		});
	});
	app.get("/api/steward/events", (c) => {
		const parsed = eventsQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw new Error("invalid_steward_input");
		return c.json({ items: service.events(parsed.data.conversationId) });
	});
}
