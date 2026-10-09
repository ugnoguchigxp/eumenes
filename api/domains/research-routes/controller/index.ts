import type { Hono } from "hono";
import type { ApiResult, RouteOperations } from "../service/operations";

/**
 * Management API. Authentication and Origin checks run in the application middleware for `/api/*`
 * before any handler here, so input validation never runs for unauthenticated callers.
 */
export function registerResearchRoutes(app: Hono, ops: RouteOperations) {
	const send = (
		c: { json: (b: unknown, s: never) => Response },
		r: ApiResult,
	) => c.json(r.body, r.status as never);
	const body = (c: { req: { json: () => Promise<unknown> } }) =>
		c.req.json().catch(() => null);
	app.get("/api/research-routes", (c) =>
		send(c, ops.list(Object.fromEntries(new URL(c.req.url).searchParams))),
	);
	app.post("/api/research-routes/clear", async (c) =>
		send(c, await ops.clear(await body(c))),
	);
	app.get("/api/research-routes/:key", (c) =>
		send(c, ops.show(c.req.param("key"))),
	);
	app.post("/api/research-routes/:key/edits", async (c) =>
		send(c, await ops.edit(c.req.param("key"), await body(c))),
	);
	app.post("/api/research-routes/:key/disable", async (c) =>
		send(c, await ops.disable(c.req.param("key"), await body(c))),
	);
	app.post("/api/research-routes/:key/rediscover", async (c) =>
		send(c, await ops.rediscover(c.req.param("key"), await body(c))),
	);
}
