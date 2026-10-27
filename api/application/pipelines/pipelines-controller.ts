import type { Context, Hono } from "hono";
import { limitConcurrency } from "../../infrastructure/concurrency";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { parseJsonBody } from "../../infrastructure/http";
import type { PipelinesService } from "./pipelines-service";
import type { PipelineTrials } from "./pipelines-trials";

/**
 * Checking, trying and publishing task pipelines (spec task-pipeline-design 2026-10-22 §13.2). The usual
 * authentication and Origin checks apply; a refused definition comes back with its findings (where and which rule).
 */
export function registerPipelines(
	app: Hono,
	service: PipelinesService,
	trials?: PipelineTrials,
) {
	app.use(
		"/api/pipelines/*",
		bodyLimit({
			maxSize: 65_536,
			onError: (c) => c.json({ error: "payload_too_large" }, 413),
		}),
	);
	const body = z.strictObject({ definition: z.unknown() });
	app.post("/api/pipelines/check", async (c) => {
		const b = await parseJsonBody(c, body, { code: "invalid_pipeline" });
		if (!b.ok) return b.response;
		const result = service.check(b.data.definition);
		return c.json(result.ok ? { ok: true } : result, result.ok ? 200 : 422);
	});
	app.post("/api/pipelines/fixture", async (c) => {
		const b = await parseJsonBody(
			c,
			body.extend({ test: z.number().int().min(0).max(7) }),
			{ code: "invalid_pipeline" },
		);
		if (!b.ok) return b.response;
		const result = service.fixture(b.data.definition, b.data.test);
		return c.json(result, result.ok ? 200 : 422);
	});
	app.post("/api/pipelines/publish", async (c) => {
		const b = await parseJsonBody(c, body, { code: "invalid_pipeline" });
		if (!b.ok) return b.response;
		const result = await service.publish(b.data.definition);
		return c.json(result, result.ok ? 200 : 422);
	});
	if (!trials) return;
	// The studio's trials of a work's current draft: the server reads the draft from the work, never from the body.
	// A refused or unavailable trial is an ordinary answer ({ok:false}); a malformed request or an unknown work is
	// an error. Probe and selection call the embedding and the model: at most two run at once.
	app.use("/api/pipelines/works/*", limitConcurrency(2));
	const text = z.string().trim().min(1).max(500);
	const run = async <T>(
		c: Context,
		trial: (workRef: string) => Promise<T> | T,
	) => {
		const workRef = z.uuid().safeParse(c.req.param("workRef"));
		if (!workRef.success)
			return c.json({ error: "invalid_pipeline_trial" }, 400);
		return c.json(await trial(workRef.data));
	};
	app.post("/api/pipelines/works/:workRef/probe", async (c) => {
		const b = await parseJsonBody(c, z.strictObject({ query: text }), {
			code: "invalid_pipeline_trial",
		});
		if (!b.ok) return b.response;
		return run(c, (workRef) =>
			trials.probe(workRef, b.data.query, c.req.raw.signal),
		);
	});
	app.post("/api/pipelines/works/:workRef/select", async (c) => {
		const b = await parseJsonBody(c, z.strictObject({ utterance: text }), {
			code: "invalid_pipeline_trial",
		});
		if (!b.ok) return b.response;
		return run(c, (workRef) =>
			trials.select(workRef, b.data.utterance, c.req.raw.signal),
		);
	});
	app.post("/api/pipelines/works/:workRef/fixture", async (c) => {
		const b = await parseJsonBody(
			c,
			z.strictObject({ test: z.number().int().min(0).max(7) }),
			{ code: "invalid_pipeline_trial" },
		);
		if (!b.ok) return b.response;
		return run(c, (workRef) => trials.fixture(workRef, b.data.test));
	});
}
