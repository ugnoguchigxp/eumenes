import type { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "../../../infrastructure/http";
import type { WebResearchService } from "..";
export function registerWebResearch(app: Hono, service: WebResearchService) {
	app.post("/api/web-research/runs", async (c) => {
		// The service validates the input (its adapters submit the same one); unreadable JSON reaches it as null.
		const body = await parseJsonBody(c, z.unknown());
		if (!body.ok) return body.response;
		return c.json(await service.submit(body.data), 202);
	});
	app.get("/api/web-research/runs/:id", (c) => {
		const run = service.get(c.req.param("id"));
		return run ? c.json(run) : c.json({ error: "not_found" }, 404);
	});
	app.post("/api/web-research/runs/:id/cancel", async (c) => {
		const run = await service.cancel(c.req.param("id"));
		return run ? c.json(run) : c.json({ error: "not_found" }, 404);
	});
	app.get("/api/web-research/cache/status", (c) =>
		c.json(service.cacheStatus()),
	);
	app.post("/api/web-research/cache/clear", async (c) =>
		c.json(await service.clearCache()),
	);
}
