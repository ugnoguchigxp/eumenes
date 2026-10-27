import type { Hono } from "hono";
import { z } from "zod";
import {
	parseJsonBody,
	parseQuery,
	queryInt,
} from "../../../infrastructure/http";
import {
	DEFAULT_TIMER_SCOPE,
	ackNotificationSchema,
	cancelTimerSchema,
	claimNotificationSchema,
	listTimersQuerySchema,
	silenceNotificationSchema,
	startTimerSchema,
} from "../contracts";
import type { TimersService } from "../service";

const limit = queryInt.pipe(z.number().min(1).max(100)).optional();
const listQuery = z.object({ ...listTimersQuerySchema.shape, limit });
const notificationsQuery = z.object({
	cursor: z.string().optional(),
	limit,
});

export function registerTimers(app: Hono, service: TimersService) {
	app.post("/api/timers", async (c) => {
		const parsed = await parseJsonBody(c, startTimerSchema, {
			code: "invalid_timer_input",
		});
		if (!parsed.ok) return parsed.response;
		const saved = await service.start(parsed.data);
		return c.json(saved.receipt, saved.replay ? 200 : 201);
	});
	app.get("/api/timers", (c) => {
		const query = parseQuery(c, listQuery, { code: "invalid_timer_input" });
		if (!query.ok) return query.response;
		return c.json(service.list(query.data));
	});
	app.get("/api/timers/:id", (c) => {
		const view = service.get(c.req.param("id"));
		return view ? c.json(view) : c.json({ error: "timer_not_found" }, 404);
	});
	app.get("/api/timer-actions/by-run/:runId", (c) => {
		const runId = c.req.param("runId");
		if (!z.uuid().safeParse(runId).success)
			return c.json({ error: "invalid_timer_input" }, 400);
		return c.json(service.receiptByRun(runId, DEFAULT_TIMER_SCOPE));
	});
	app.post("/api/timers/:id/cancel", async (c) => {
		const parsed = await parseJsonBody(c, cancelTimerSchema, {
			code: "invalid_timer_input",
		});
		if (!parsed.ok) return parsed.response;
		const saved = await service.cancel(c.req.param("id"), parsed.data);
		return c.json(saved.receipt);
	});
	for (const operation of ["pause", "resume"] as const) {
		app.post(`/api/timers/:id/${operation}`, async (c) => {
			const parsed = await parseJsonBody(c, cancelTimerSchema, {
				code: "invalid_timer_input",
			});
			if (!parsed.ok) return parsed.response;
			const saved = await service[operation](c.req.param("id"), parsed.data);
			return c.json(saved.receipt);
		});
	}
	app.get("/api/timer-notifications", (c) => {
		const query = parseQuery(c, notificationsQuery, {
			code: "invalid_timer_input",
		});
		if (!query.ok) return query.response;
		return c.json(service.notifications(query.data));
	});
	app.post("/api/timer-notifications/:id/claim", async (c) => {
		const parsed = await parseJsonBody(c, claimNotificationSchema, {
			code: "invalid_timer_input",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(await service.claim(c.req.param("id"), parsed.data));
	});
	app.post("/api/timer-notifications/:id/ack", async (c) => {
		const parsed = await parseJsonBody(c, ackNotificationSchema, {
			code: "invalid_timer_input",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(await service.ack(c.req.param("id"), parsed.data));
	});
	app.post("/api/timer-notifications/:id/silence", async (c) => {
		const parsed = await parseJsonBody(c, silenceNotificationSchema, {
			code: "invalid_timer_input",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(await service.silence(c.req.param("id"), parsed.data));
	});
}
