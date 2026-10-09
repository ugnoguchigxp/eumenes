import type { Hono } from "hono";
import type { WebResearchService } from "..";
export function registerWebResearch(app: Hono, service: WebResearchService) {
	app.post("/api/web-research/runs", async (c) =>
		c.json(await service.submit(await c.req.json().catch(() => null)), 202),
	);
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
