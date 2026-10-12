import type { Hono } from "hono";
import type { ToolchainHistory } from "../service";

const code = (e: unknown) =>
	e instanceof Error && /^[a-z_]+$/.test(e.message)
		? e.message
		: "internal_error";
const int = (v: string | undefined) =>
	v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : undefined;
const pattern = /^[A-Za-z0-9._:-]{1,160}$/;
const id = (v: string | undefined) =>
	v !== undefined && pattern.test(v) ? v : undefined;
/** Optional filters: absent is fine, malformed is a 400 (never silently "no filter"). */
const valid = (q: URLSearchParams) =>
	["runId", "toolchain"].every((k) => !q.has(k) || pattern.test(q.get(k)!)) &&
	["since", "cursor", "limit"].every(
		(k) => !q.has(k) || /^\d{1,16}$/.test(q.get(k)!),
	);

/**
 * Trace and procedure management. Authentication and Origin checks run in the application
 * middleware for `/api/*` before any handler here.
 */
export function registerToolchainHistory(app: Hono, history: ToolchainHistory) {
	app.get("/api/toolchain-history/selections", (c) => {
		const q = new URL(c.req.url).searchParams;
		if (!valid(q)) return c.json({ error: "invalid_request" }, 400);
		return c.json(
			history.listSelections({
				runId: id(q.get("runId") ?? undefined),
				toolchainId: id(q.get("toolchain") ?? undefined),
				since: int(q.get("since") ?? undefined),
				cursor: int(q.get("cursor") ?? undefined),
				limit: int(q.get("limit") ?? undefined),
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
		const q = new URL(c.req.url).searchParams;
		if (!valid(q)) return c.json({ error: "invalid_request" }, 400);
		return c.json({
			items: history.listRecipes(id(q.get("toolchain") ?? undefined)),
		});
	});
	app.post("/api/toolchain-history/recipes/:id/state", async (c) => {
		const body = (await c.req.json().catch(() => null)) as {
			state?: unknown;
		} | null;
		const key = id(c.req.param("id"));
		if (!key || (body?.state !== "active" && body?.state !== "disabled"))
			return c.json({ error: "invalid_request" }, 400);
		try {
			await history.setRecipeState(key, body.state);
			return c.json({ ok: true });
		} catch (e) {
			return c.json(
				{ error: code(e) },
				code(e) === "recipe_not_found" ? 404 : 500,
			);
		}
	});
	app.delete("/api/toolchain-history/recipes/:id", async (c) => {
		const key = id(c.req.param("id"));
		if (!key) return c.json({ error: "invalid_request" }, 400);
		try {
			await history.deleteRecipe(key);
			return c.json({ ok: true });
		} catch (e) {
			return c.json(
				{ error: code(e) },
				code(e) === "recipe_not_found" ? 404 : 500,
			);
		}
	});
}
