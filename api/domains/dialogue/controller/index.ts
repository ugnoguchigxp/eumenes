import type { Hono } from "hono";
import type { DialogueService } from "..";
import { publicSubmitSchema, type RunProgress } from "../contracts";
import { parseJsonBody } from "../../../infrastructure/http";
import { snapshotStream } from "../../../infrastructure/snapshot-stream";
export function registerDialogue(app: Hono, service: DialogueService) {
	app.get("/api/runs/:id/stream", (c) => {
		const id = c.req.param("id");
		if (!service.get(id)) return c.json({ error: "not_found" }, 404);
		return c.body(
			snapshotStream<RunProgress>(
				(listener) => service.subscribeProgress(id, listener),
				(value) => !["queued", "running"].includes(value.status),
				c.req.raw.signal,
			),
			200,
			{
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				"X-Accel-Buffering": "no",
			},
		);
	});
	app.get("/api/conversations/:id/runs", (c) =>
		c.json(service.list(c.req.param("id"))),
	);
	app.post("/api/runs", async (c) => {
		const parsed = await parseJsonBody(c, publicSubmitSchema);
		if (!parsed.ok) return parsed.response;
		return c.json(await service.submit(parsed.data), 202);
	});
	app.get("/api/runs/:id", (c) => {
		const run = service.get(c.req.param("id"));
		return run ? c.json(run) : c.json({ error: "not_found" }, 404);
	});
	app.post("/api/runs/:id/cancel", async (c) => {
		const run = await service.cancel(c.req.param("id"));
		return run ? c.json(run) : c.json({ error: "not_found" }, 404);
	});
}
