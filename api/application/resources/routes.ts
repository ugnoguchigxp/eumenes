import type { Hono } from "hono";
import { z } from "zod";
import { RESOURCE_SEARCH_LIMIT_MAX } from "../../domains/resources";
import type { ResourceAccess } from "./access";

const DEFAULT_LIMIT = 5;

const searchQuerySchema = z.strictObject({
	query: z.string().max(200).default(""),
	kind: z.string().trim().min(1).max(80).optional(),
	since: z.iso.datetime({ offset: true }).optional(),
	until: z.iso.datetime({ offset: true }).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(RESOURCE_SEARCH_LIMIT_MAX)
		.default(DEFAULT_LIMIT),
});

export function registerResourceRoutes(
	app: Hono,
	deps: { access: ResourceAccess },
) {
	app.get("/api/resources/resolve", (c) => {
		const uri = c.req.query("uri");
		if (!uri) return c.json({ ok: false, code: "resource_uri_invalid" }, 400);
		const resolved = deps.access.resolve(uri);
		if (resolved.ok) return c.json(resolved);
		return c.json(
			resolved,
			resolved.code === "resource_uri_invalid" ? 400 : 404,
		);
	});
	app.get("/api/resources", async (c) => {
		const parsed = searchQuerySchema.safeParse(c.req.query());
		if (!parsed.success)
			return c.json({ error: "invalid_resource_query" }, 400);
		const { query, ...rest } = parsed.data;
		return c.json(
			await deps.access.search({ text: query, ...rest }, c.req.raw.signal),
		);
	});
}
