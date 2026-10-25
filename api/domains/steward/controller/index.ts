import type { Hono } from "hono";
import {
	activityQuerySchema,
	decisionsQuerySchema,
	eventsQuerySchema,
} from "../contracts";
import type { StewardService } from "../service";

/** Read-only: what the steward decided, the event log it works from, and what it does now. */
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
	app.get("/api/steward/activity", (c) => {
		const parsed = activityQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw new Error("invalid_steward_input");
		return c.json(service.activity(parsed.data.conversationId));
	});
	app.get("/api/steward/error-report", async (c) => {
		const parsed = activityQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw new Error("invalid_steward_input");
		const text = await service.errorReport(parsed.data.conversationId);
		return text === null
			? c.json({ error: "steward_error_report_not_found" }, 404)
			: c.json({ text });
	});
}
