import type { Hono } from "hono";
import type { TaskReports } from "../service";
export function registerTaskReports(app: Hono, reports: TaskReports) {
	app.get("/api/tasks/:id/reports", (c) =>
		c.json(
			reports.list(
				c.req.param("id"),
				Number(c.req.query("after") ?? 0),
				Number(c.req.query("limit") ?? 50),
			),
		),
	);
}
