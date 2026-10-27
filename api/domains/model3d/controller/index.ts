import type { Context, Hono } from "hono";
import { z } from "zod";
import {
	model3dCreate,
	model3dId,
	model3dTag,
	model3dTags,
	model3dTitle,
} from "../contracts";
import { parseJsonBody, parseQuery } from "../../../infrastructure/http";
import type { Model3dService } from "../service";

const assetQuery = z.strictObject({
	q: z.string().trim().max(200).optional(),
	tags: z.string().max(400).optional(),
	sort: z.enum(["createdAt", "relevance"]).optional(),
	order: z.enum(["asc", "desc"]).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	cursor: z.string().min(1).max(2048).optional(),
});
const assetPatch = z
	.strictObject({
		title: model3dTitle.optional(),
		tags: model3dTags.optional(),
	})
	.refine((p) => p.title !== undefined || p.tags !== undefined);
const noStore = { "Cache-Control": "no-store" };
const local = new Set([
	"request_conflict",
	"model3d_capacity",
	"model3d_generation_not_found",
	"model3d_not_recheckable",
]);

/** LARM's refusal as an HTTP answer; anything unexpected is a 502 without upstream details. */
function failure(c: Context, e: unknown) {
	const code = e instanceof Error ? e.message : "";
	if (code === "request_conflict") return c.json({ error: code }, 409);
	if (code === "model3d_capacity") return c.json({ error: code }, 429);
	if (code === "model3d_generation_not_found" || code === "larm_http_404")
		return c.json({ error: "model3d_not_found" }, 404);
	if (local.has(code)) return c.json({ error: code }, 409);
	if (code === "model3d_larm_unconfigured" || code === "larm_unconfigured")
		return c.json({ error: "model3d_larm_unconfigured" }, 503);
	if (code === "larm_http_401" || code === "larm_http_403")
		return c.json({ error: "model3d_auth_failed" }, 502);
	if (code === "larm_http_429") return c.json({ error: "model3d_busy" }, 429);
	if (code === "larm_http_503")
		return c.json({ error: "model3d_unavailable" }, 503);
	if (code === "larm_http_507")
		return c.json({ error: "model3d_storage_full" }, 507);
	if (code === "larm_http_400" || code === "larm_http_422")
		return c.json({ error: "model3d_invalid_request" }, 400);
	return c.json({ error: "model3d_larm_failed" }, 502);
}
function media(content: { bytes: Uint8Array; mime: string }, name: string) {
	return new Response(new Uint8Array(content.bytes), {
		headers: {
			"Content-Type": content.mime,
			// An asset's content never changes under its ID; the browser keeps it for this user only.
			"Cache-Control": "private, max-age=86400, immutable",
			"X-Content-Type-Options": "nosniff",
			"Content-Disposition": `inline; filename="${name}"`,
		},
	});
}

export function registerModel3d(app: Hono, s: Model3dService, owner: string) {
	const id = (c: Context) => model3dId.safeParse(c.req.param("id"));
	app.get("/api/model3d/status", async (c) =>
		c.json(await s.status(c.req.raw.signal), 200, noStore),
	);
	app.get("/api/model3d/generations", (c) =>
		c.json({ generations: s.list(owner) }, 200, noStore),
	);
	app.post("/api/model3d/generations", async (c) => {
		const body = await parseJsonBody(c, model3dCreate, {
			code: "invalid_model3d_request",
		});
		if (!body.ok) return body.response;
		try {
			return c.json(await s.create(owner, "main", body.data), 202, noStore);
		} catch (e) {
			return failure(c, e);
		}
	});
	for (const action of ["cancel", "recheck"] as const)
		app.post(`/api/model3d/generations/:id/${action}`, async (c) => {
			const g = z.uuid().safeParse(c.req.param("id"));
			if (!g.success) return c.json({ error: "invalid_model3d_id" }, 400);
			try {
				return c.json(await s[action](owner, g.data), 200, noStore);
			} catch (e) {
				return failure(c, e);
			}
		});
	app.get("/api/model3d/assets", async (c) => {
		const q = parseQuery(c, assetQuery, { code: "invalid_model3d_query" });
		if (!q.ok) return q.response;
		const tags = q.data.tags
			?.split(/[,、，]/)
			.map((t) => t.trim())
			.filter(Boolean);
		if (tags && !z.array(model3dTag).max(8).safeParse(tags).success)
			return c.json({ error: "invalid_model3d_query" }, 400);
		try {
			return c.json(
				await s.assets(
					owner,
					{
						...q.data,
						q: q.data.q || undefined,
						tags,
						// Relevance needs words to rank by.
						sort: q.data.q ? q.data.sort : q.data.sort && "createdAt",
					},
					c.req.raw.signal,
				),
				200,
				noStore,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.get("/api/model3d/assets/:id", async (c) => {
		const a = id(c);
		if (!a.success) return c.json({ error: "invalid_model3d_id" }, 400);
		try {
			return c.json(
				await s.asset(owner, a.data, c.req.raw.signal),
				200,
				noStore,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.patch("/api/model3d/assets/:id", async (c) => {
		const a = id(c);
		const body = await parseJsonBody(c, assetPatch, {
			code: "invalid_model3d_request",
		});
		if (!body.ok) return body.response;
		if (!a.success) return c.json({ error: "invalid_model3d_request" }, 400);
		try {
			return c.json(
				await s.update(owner, a.data, body.data, c.req.raw.signal),
				200,
				noStore,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.delete("/api/model3d/assets/:id", async (c) => {
		const a = id(c);
		if (!a.success) return c.json({ error: "invalid_model3d_id" }, 400);
		try {
			await s.remove(owner, a.data, c.req.raw.signal);
			return c.body(null, 204);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.get("/api/model3d/assets/:id/content", async (c) => {
		const a = id(c);
		if (!a.success) return c.json({ error: "invalid_model3d_id" }, 400);
		try {
			return media(
				await s.content(a.data, c.req.raw.signal),
				`model-${a.data}.glb`,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.get("/api/model3d/assets/:id/source", async (c) => {
		const a = id(c);
		if (!a.success) return c.json({ error: "invalid_model3d_id" }, 400);
		try {
			const content = await s.source(a.data, c.req.raw.signal);
			const ext = content.mime.split("/")[1] ?? "img";
			return media(content, `model-${a.data}-source.${ext}`);
		} catch (e) {
			return failure(c, e);
		}
	});
}
