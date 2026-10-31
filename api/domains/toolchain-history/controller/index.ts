import type { Hono } from "hono";
import { z } from "zod";
import {
	parseJsonBody,
	parseQuery,
	queryInt,
} from "../../../infrastructure/http";
import type { ToolchainHistory } from "../service";
import { recipeStateBody } from "../contracts";

const pattern = /^[A-Za-z0-9._:-]{1,160}$/;
const id = (v: string | undefined) =>
	v !== undefined && pattern.test(v) ? v : undefined;
/** Optional filters: absent is fine, malformed is a 400 (never silently "no filter"). */
const listQuery = z.object({
	runId: z.string().regex(pattern).optional(),
	toolchain: z.string().regex(pattern).optional(),
	since: queryInt.optional(),
	cursor: queryInt.optional(),
	limit: queryInt.optional(),
});

/**
 * Trace and procedure management. Authentication and Origin checks run in the application
 * middleware for `/api/*` before any handler here.
 */
export function registerToolchainHistory(app: Hono, history: ToolchainHistory) {
	app.get("/api/toolchain-history/selections", (c) => {
		const q = parseQuery(c, listQuery, { code: "invalid_request" });
		if (!q.ok) return q.response;
		return c.json(
			history.listSelections({
				runId: q.data.runId,
				toolchainId: q.data.toolchain,
				since: q.data.since,
				cursor: q.data.cursor,
				limit: q.data.limit,
			}),
		);
	});
	app.get("/api/toolchain-history/selections/:id", (c) => {
		const key = id(c.req.param("id"));
		const found = key ? history.getSelection(key) : null;
		return found
			? c.json(found)
			: c.json({ error: "selection_not_found" }, 404);
	});
	app.get("/api/toolchain-history/recipes", (c) => {
		const q = parseQuery(c, listQuery, { code: "invalid_request" });
		if (!q.ok) return q.response;
		return c.json({ items: history.listRecipes(q.data.toolchain) });
	});
	app.post("/api/toolchain-history/recipes/:id/state", async (c) => {
		const body = await parseJsonBody(c, recipeStateBody, {
			code: "invalid_request",
		});
		if (!body.ok) return body.response;
		const key = id(c.req.param("id"));
		if (!key) return c.json({ error: "invalid_request" }, 400);
		await history.setRecipeState(key, body.data.state);
		return c.json({ ok: true });
	});
	app.delete("/api/toolchain-history/recipes/:id", async (c) => {
		const key = id(c.req.param("id"));
		if (!key) return c.json({ error: "invalid_request" }, 400);
		await history.deleteRecipe(key);
		return c.json({ ok: true });
	});
}
