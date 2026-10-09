import type { Hono } from "hono";
import type { CodingService } from "../service";
export function registerCoding(app: Hono, coding: CodingService) {
	app.get("/api/coding/workspaces", (c) =>
		c.json({ items: coding.workspaces() }),
	);
	app.get("/api/coding/executions/:id", (c) =>
		c.json(coding.get(c.req.param("id"))),
	);
	app.get("/api/coding/executions/:id/events", (c) =>
		c.json(
			coding.events(
				c.req.param("id"),
				Number(c.req.query("after") ?? 0),
				Number(c.req.query("limit") ?? 100),
			),
		),
	);
}
