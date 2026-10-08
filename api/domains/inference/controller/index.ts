import type { Hono } from "hono";
import type { InferenceService } from "../service";
export function registerInference(app: Hono, service: InferenceService) {
	app.get("/api/inference/status", (c) => c.json(service.status()));
	app.get("/api/inference/larm", (c) => c.json(service.inspect()));
	app.get("/api/inference/voices", async (c) =>
		c.json(
			await service.voices(
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
			),
		),
	);
	app.get("/api/inference/usage", (c) => c.json(service.usage()));
	app.get("/api/inference/probes", (c) => c.json(service.probes()));
	app.post("/api/inference/probes", async (c) => {
		const body = await c.req.text();
		if (body.length > 2048) return c.json({ error: "invalid_body" }, 413);
		let target: unknown;
		try {
			target = (JSON.parse(body) as { target?: unknown }).target;
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}
		if (typeof target !== "string" || target.length > 100)
			return c.json({ error: "invalid_target" }, 400);
		return c.json(await service.startProbe(target), 202);
	});
	app.get("/api/inference/probes/:id", (c) => {
		const probe = service.getProbe(c.req.param("id"));
		return probe ? c.json(probe) : c.json({ error: "not_found" }, 404);
	});
	app.post("/api/inference/probes/:id/cancel", (c) => {
		service.cancelProbe(c.req.param("id"));
		return c.json({ ok: true });
	});
}
