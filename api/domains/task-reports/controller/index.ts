import type { Hono } from "hono";
import { z } from "zod";
import { parseQuery, queryInt } from "../../../infrastructure/http";
import type { TaskReports } from "../service";
const listQuery = z.object({
	after: queryInt.default(0),
	limit: queryInt.default(50),
});
export function registerTaskReports(app: Hono, reports: TaskReports) {
	app.get("/api/tasks/:id/reports", (c) => {
		const query = parseQuery(c, listQuery, {
			code: "invalid_task_report_query",
		});
		if (!query.ok) return query.response;
		return c.json(
			reports.list(c.req.param("id"), query.data.after, query.data.limit),
		);
	});
}
