import type { Hono } from "hono";
import { cancelBodySchema } from "../contracts";
import type { QueueService } from "../service";
import { toDto } from "../service";

export function registerQueue(app: Hono, service: QueueService) {
	app.get("/api/queue/status", (c) => c.json(service.stats()));
	app.get("/api/jobs", (c) => {
		const q = c.req.query();
		const limit = q.limit === undefined ? 50 : Number(q.limit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			return c.json({ error: "invalid_limit" }, 400);
		return c.json(
			service.list(
				{
					scope: q.scope,
					state: q.state,
					kind: q.kind,
					subjectRef: q.subjectRef,
				},
				q.cursor ?? null,
				limit,
			),
		);
	});
	app.get("/api/jobs/:id", (c) => {
		const job = service.getDto(c.req.param("id"));
		return job ? c.json(job) : c.json({ error: "not_found" }, 404);
	});
	app.get("/api/jobs/:id/attempts", (c) => {
		if (!service.get(c.req.param("id")))
			return c.json({ error: "not_found" }, 404);
		return c.json(service.listAttempts(c.req.param("id")));
	});
	app.post("/api/jobs/:id/cancel", async (c) => {
		const body = cancelBodySchema.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!body.success) return c.json({ error: "invalid_input" }, 400);
		const job = await service.cancel(
			c.req.param("id"),
			body.data.reason ?? "cancel_requested",
		);
		return job ? c.json(toDto(job)) : c.json({ error: "not_found" }, 404);
	});
}
