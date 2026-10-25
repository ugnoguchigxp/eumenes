import { z } from "zod";
import type { Hono } from "hono";
import { analysisCreate, type AnalysisRecord } from "../../larm";
import type { createRecognitionAnalyses } from "../service/analyses";
const summary = (v: AnalysisRecord) => ({
	...v,
	result: v.result
		? { ...v.result, masks: v.result.masks.map((m) => ({ ...m, data: "" })) }
		: null,
});
export function registerRecognitionAnalyses(
	app: Hono,
	service: ReturnType<typeof createRecognitionAnalyses>,
	owner: string,
) {
	const root = "/api/object-recognition/:id/analyses";
	const scope = z.object({
		conversationId: z.string().min(1).max(120),
		frameIndex: z.coerce.number().int().min(0).max(59).optional(),
	});
	app.post(root, async (c) => {
		const v = analysisCreate.safeParse(await c.req.json());
		if (!v.success) return c.json({ error: "invalid_analysis_input" }, 400);
		return c.json(
			summary(await service.create(owner, c.req.param("id"), v.data)),
			202,
		);
	});
	app.get(root, (c) => {
		const q = scope.safeParse(c.req.query());
		if (!q.success) return c.json({ error: "invalid_analysis_input" }, 400);
		return c.json(
			service
				.list(
					owner,
					c.req.param("id"),
					q.data.conversationId,
					q.data.frameIndex,
				)
				.map(summary),
		);
	});
	app.get(`${root}/:analysisId`, (c) => {
		const q = scope.safeParse(c.req.query());
		if (!q.success) return c.json({ error: "invalid_analysis_input" }, 400);
		return c.json(
			summary(
				service.get(
					owner,
					c.req.param("id"),
					c.req.param("analysisId"),
					q.data.conversationId,
				),
			),
		);
	});
	app.post(`${root}/:analysisId/cancel`, async (c) => {
		const q = scope.safeParse(await c.req.json());
		if (!q.success) return c.json({ error: "invalid_analysis_input" }, 400);
		return c.json(
			summary(
				await service.cancel(
					owner,
					c.req.param("id"),
					c.req.param("analysisId"),
					q.data.conversationId,
				),
			),
		);
	});
	app.get(`${root}/:analysisId/image`, async (c) => {
		const q = scope.safeParse(c.req.query());
		if (!q.success) return c.json({ error: "invalid_analysis_input" }, 400);
		const image = await service.image(
			owner,
			c.req.param("id"),
			c.req.param("analysisId"),
			q.data.conversationId,
			AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
		);
		return new Response(new Uint8Array(image.bytes), {
			headers: {
				"Content-Type": image.mime,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});
	app.get(`${root}/:analysisId/masks/:index`, (c) => {
		const q = scope.safeParse(c.req.query());
		const index = z.coerce
			.number()
			.int()
			.min(0)
			.max(7)
			.safeParse(c.req.param("index"));
		if (!q.success || !index.success)
			return c.json({ error: "invalid_analysis_input" }, 400);
		const r = service.get(
			owner,
			c.req.param("id"),
			c.req.param("analysisId"),
			q.data.conversationId,
		);
		const mask = r.state === "completed" && r.result?.masks[index.data];
		if (!mask) return c.json({ error: "analysis_not_found" }, 404);
		return new Response(Buffer.from(mask.data, "base64"), {
			headers: {
				"Content-Type": "image/png",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});
}
