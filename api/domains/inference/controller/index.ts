import type { Hono } from "hono";
import { z } from "zod";
import { parseQuery } from "../../../infrastructure/http";
import type { InferenceService } from "../service";
import type { ConnectionModelsService } from "../service/connection-models";
import { registerScreenPresence } from "./screen-presence";
const modelsQuery = z.object({ refresh: z.literal("1").optional() });
const voicesQuery = z.object({ language: z.enum(["ja", "en"]).optional() });
/** Credential and route failures of a model-list read; anything else is an upstream failure. */
const modelListStatus = (code: string) =>
	code === "cloud_credential_unavailable" ? 409 : 502;
export function registerInference(
	app: Hono,
	service: InferenceService,
	models?: ConnectionModelsService,
) {
	registerScreenPresence(app, service);
	if (models)
		app.get("/api/inference/connections/:id/models", async (c) => {
			const query = parseQuery(c, modelsQuery, { code: "invalid_request" });
			if (!query.ok) return query.response;
			try {
				const result = await models.list(
					c.req.param("id"),
					AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
					query.data.refresh === "1",
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
	app.get("/api/inference/larm", (c) => c.json(service.inspect()));
	app.get("/api/inference/larm/profiles", async (c) =>
		c.json(
			await service.larmProfiles(
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
			),
		),
	);
	app.get("/api/inference/voices", async (c) => {
		const query = parseQuery(c, voicesQuery, { code: "invalid_language" });
		if (!query.ok) return query.response;
		return c.json(
			await service.voices(
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
				query.data.language,
			),
		);
	});
	app.get("/api/inference/usage", (c) => c.json(service.usage()));
}
