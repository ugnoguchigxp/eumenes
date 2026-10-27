import type { Hono } from "hono";
import { z } from "zod";
import {
	parseJsonBody,
	parseQuery,
	queryInt,
} from "../../../infrastructure/http";
import { createScheduleSchema, scheduleOperationSchema } from "../contracts";
import type { SchedulerService } from "../service";

const pageQuery = z.object({
	state: z.string().optional(),
	cursor: z.string().optional(),
	limit: queryInt.pipe(z.number().min(1).max(100)).default(50),
});

export function registerScheduler(app: Hono, service: SchedulerService) {
	app.post("/api/schedules", async (c) => {
		const parsed = await parseJsonBody(c, createScheduleSchema);
		if (!parsed.ok) return parsed.response;
		return c.json(await service.create(parsed.data), 201);
	});
	app.get("/api/schedules", (c) => {
		const page = parseQuery(c, pageQuery, { code: "invalid_limit" });
		if (!page.ok) return page.response;
		return c.json(
			service.list(page.data.state, page.data.cursor ?? null, page.data.limit),
		);
	});
	app.get("/api/schedules/:id", (c) => {
		const schedule = service.get(c.req.param("id"));
		return schedule ? c.json(schedule) : c.json({ error: "not_found" }, 404);
	});
	app.get("/api/schedules/:id/occurrences", (c) => {
		if (!service.get(c.req.param("id")))
			return c.json({ error: "not_found" }, 404);
		const page = parseQuery(c, pageQuery, { code: "invalid_limit" });
		if (!page.ok) return page.response;
		return c.json(
			service.listOccurrences(
				c.req.param("id"),
				page.data.cursor ?? null,
				page.data.limit,
			),
		);
	});
	for (const operation of ["pause", "resume", "cancel"] as const)
		app.post(`/api/schedules/:id/${operation}`, async (c) => {
			const body = await parseJsonBody(c, scheduleOperationSchema);
			if (!body.ok) return body.response;
			const schedule = await service[operation](
				c.req.param("id"),
				body.data.expectedRevision,
			);
			return schedule ? c.json(schedule) : c.json({ error: "not_found" }, 404);
		});
}
