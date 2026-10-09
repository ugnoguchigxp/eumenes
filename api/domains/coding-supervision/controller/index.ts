import type { Hono } from "hono";
import type { CodingSupervision } from "../service";
export function registerCodingSupervision(
	app: Hono,
	supervision: CodingSupervision,
) {
	app.get("/api/tasks/:id/supervisor", (c) =>
		c.json(supervision.get(c.req.param("id"))),
	);
}
