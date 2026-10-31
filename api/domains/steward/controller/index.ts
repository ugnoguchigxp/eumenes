import type { Hono } from "hono";
import { parseQuery } from "../../../infrastructure/http";
import { activityQuerySchema, decisionsQuerySchema } from "../contracts";
import type { StewardService } from "../service";

/** Read-only: what the steward decided and what it does now. */
export function registerSteward(app: Hono, service: StewardService) {
	app.get("/api/steward/decisions", (c) => {
		const parsed = parseQuery(c, decisionsQuerySchema, {
			code: "invalid_steward_input",
		});
		if (!parsed.ok) return parsed.response;
		return c.json({
			items: service.decisions(parsed.data.conversationId, parsed.data.limit),
		});
	});
	app.get("/api/steward/activity", (c) => {
		const parsed = parseQuery(c, activityQuerySchema, {
			code: "invalid_steward_input",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(service.activity(parsed.data.conversationId));
	});
	app.get("/api/steward/error-report", async (c) => {
		const parsed = parseQuery(c, activityQuerySchema, {
			code: "invalid_steward_input",
		});
		if (!parsed.ok) return parsed.response;
		const text = await service.errorReport(parsed.data.conversationId);
		return text === null
			? c.json({ error: "steward_error_report_not_found" }, 404)
			: c.json({ text });
	});
}
