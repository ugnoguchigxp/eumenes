import type { Hono } from "hono";
import { parseJsonBody } from "../../../infrastructure/http";
import { createScheduleSchema, scheduleOperationSchema } from "../contracts";
import type { SchedulerService } from "../service";

export function registerScheduler(app: Hono, service: SchedulerService) {
	const page = (value: string | undefined) => {
		const limit = value === undefined ? 50 : Number(value);
		return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
	};
	app.post("/api/schedules", async (c) => {
		const parsed = await parseJsonBody(c, createScheduleSchema);
		if (!parsed.ok) return parsed.response;
		return c.json(await service.create(parsed.data), 201);
	});
	app.get("/api/schedules", (c) => {
		const limit = page(c.req.query("limit"));
		if (limit === null) return c.json({ error: "invalid_limit" }, 400);
		return c.json(
			service.list(c.req.query("state"), c.req.query("cursor") ?? null, limit),
		);
	});
	app.get("/api/schedules/:id", (c) => {
		const schedule = service.get(c.req.param("id"));
		return schedule ? c.json(schedule) : c.json({ error: "not_found" }, 404);
	});
	app.get("/api/schedules/:id/occurrences", (c) => {
		if (!service.get(c.req.param("id")))
			return c.json({ error: "not_found" }, 404);
		const limit = page(c.req.query("limit"));
		if (limit === null) return c.json({ error: "invalid_limit" }, 400);
		return c.json(
			service.listOccurrences(
				c.req.param("id"),
				c.req.query("cursor") ?? null,
				limit,
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
