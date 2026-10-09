import type { Hono } from "hono";
import { z } from "zod";
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

const limitOf = (value: string | undefined) => {
	if (value === undefined) return undefined;
	const limit = Number(value);
	return Number.isInteger(limit) ? limit : Number.NaN;
};

export function registerTimers(app: Hono, service: TimersService) {
	app.post("/api/timers", async (c) => {
		const parsed = startTimerSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_timer_input" }, 400);
		const saved = await service.start(parsed.data);
		return c.json(saved.receipt, saved.replay ? 200 : 201);
	});
	app.get("/api/timers", (c) => {
		const limit = limitOf(c.req.query("limit"));
		if (Number.isNaN(limit))
			return c.json({ error: "invalid_timer_input" }, 400);
		const query = listTimersQuerySchema.safeParse({
			state: c.req.query("state"),
			conversationId: c.req.query("conversationId"),
			timerId: c.req.query("timerId"),
			cursor: c.req.query("cursor"),
			limit,
		});
		if (!query.success) return c.json({ error: "invalid_timer_input" }, 400);
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
		const parsed = cancelTimerSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_timer_input" }, 400);
		const saved = await service.cancel(c.req.param("id"), parsed.data);
		return c.json(saved.receipt);
	});
	app.get("/api/timer-notifications", (c) => {
		const limit = limitOf(c.req.query("limit"));
		if (Number.isNaN(limit))
			return c.json({ error: "invalid_timer_input" }, 400);
		if (
			limit !== undefined &&
			(!Number.isInteger(limit) || limit < 1 || limit > 100)
		)
			return c.json({ error: "invalid_timer_input" }, 400);
		return c.json(
			service.notifications({
				cursor: c.req.query("cursor"),
				limit,
			}),
		);
	});
	app.post("/api/timer-notifications/:id/claim", async (c) => {
		const parsed = claimNotificationSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_timer_input" }, 400);
		return c.json(await service.claim(c.req.param("id"), parsed.data));
	});
	app.post("/api/timer-notifications/:id/ack", async (c) => {
		const parsed = ackNotificationSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_timer_input" }, 400);
		return c.json(await service.ack(c.req.param("id"), parsed.data));
	});
	app.post("/api/timer-notifications/:id/silence", async (c) => {
		const parsed = silenceNotificationSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_timer_input" }, 400);
		return c.json(await service.silence(c.req.param("id"), parsed.data));
	});
}
