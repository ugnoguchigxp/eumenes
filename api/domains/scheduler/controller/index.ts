import type { Hono } from "hono";
import { createScheduleSchema, scheduleOperationSchema } from "../contracts";
import type { SchedulerService } from "../service";

export function registerScheduler(app: Hono, service: SchedulerService) {
	const page = (value: string | undefined) => {
		const limit = value === undefined ? 50 : Number(value);
		return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
	};
	app.post("/api/schedules", async (c) => {
		const parsed = createScheduleSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
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
			const body = scheduleOperationSchema.safeParse(
				await c.req.json().catch(() => null),
			);
			if (!body.success) return c.json({ error: "invalid_input" }, 400);
			const schedule = await service[operation](
				c.req.param("id"),
				body.data.expectedRevision,
			);
			return schedule ? c.json(schedule) : c.json({ error: "not_found" }, 404);
		});
}
