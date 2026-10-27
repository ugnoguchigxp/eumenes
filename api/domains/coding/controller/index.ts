import type { Hono } from "hono";
import { z } from "zod";
import { parseQuery, queryInt } from "../../../infrastructure/http";
import type { CodingService } from "../service";
const eventsQuery = z.object({
	after: queryInt.default(0),
	limit: queryInt.default(100),
});
export function registerCoding(app: Hono, coding: CodingService) {
	app.get("/api/coding/workspaces", (c) =>
		c.json({ items: coding.workspaces() }),
	);
	app.get("/api/coding/executions/:id", (c) =>
		c.json(coding.get(c.req.param("id"))),
	);
	app.get("/api/coding/executions/:id/events", (c) => {
		const query = parseQuery(c, eventsQuery, { code: "coding_invalid_cursor" });
		if (!query.ok) return query.response;
		return c.json(
			coding.events(c.req.param("id"), query.data.after, query.data.limit),
		);
	});
}
