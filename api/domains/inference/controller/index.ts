import type { Hono } from "hono";
import type { InferenceService } from "../service";
import type { ConnectionModelsService } from "../service/connection-models";
import { usagePageQuerySchema } from "../contracts";
/** Credential and route failures of a model-list read; anything else is an upstream failure. */
const modelListStatus = (code: string) =>
	code === "cloud_credential_unavailable" ? 409 : 502;
export function registerInference(
	app: Hono,
	service: InferenceService,
	models?: ConnectionModelsService,
) {
	if (models)
		app.get("/api/inference/connections/:id/models", async (c) => {
			const refresh = c.req.query("refresh");
			if (refresh !== undefined && refresh !== "1")
				return c.json({ error: "invalid_request" }, 400);
			try {
				const result = await models.list(
					c.req.param("id"),
					AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
					refresh === "1",
				);
				return result ? c.json(result) : c.json({ error: "not_found" }, 404);
			} catch (error) {
				const code =
					error instanceof Error &&
					/^[a-z][a-z0-9_]{0,100}$/.test(error.message)
						? error.message
						: "cloud_agent_failed";
				return c.json({ error: code }, modelListStatus(code));
			}
		});
	app.get("/api/inference/status", (c) => c.json(service.status()));
	app.get("/api/inference/larm", (c) => c.json(service.inspect()));
	app.get("/api/inference/larm/profiles", async (c) =>
		c.json(
			await service.larmProfiles(
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
			),
		),
	);
	app.get("/api/inference/speech-routing", async (c) =>
		c.json(
			await service.speechRouting(
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
			),
		),
	);
	app.get("/api/inference/voices", async (c) => {
		const language = c.req.query("language");
		if (language !== undefined && language !== "ja" && language !== "en")
			return c.json({ error: "invalid_language" }, 400);
		return c.json(
			await service.voices(
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
				language,
			),
		);
	});
	app.get("/api/inference/usage", (c) => c.json(service.usage()));
	app.get("/api/inference/usage/page", (c) => {
		const query = usagePageQuerySchema.safeParse(c.req.query());
		return query.success
			? c.json(service.usagePage(query.data))
			: c.json({ error: "invalid_request" }, 400);
	});
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
