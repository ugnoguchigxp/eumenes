import type { Hono } from "hono";
import {
	WORLD_QUERY_LIMITS,
	type WorldQueryContext,
	type WorldQueryResult,
} from "../contracts/query";
import type { WorldQuery } from "../service/world-query";

const statusOf = (result: WorldQueryResult): 200 | 400 | 404 | 409 | 503 => {
	switch (result.status) {
		case "ok":
			return 200;
		case "disabled":
			return 409;
		case "blocked":
			return 503;
		case "rejected":
			// Not found and not allowed are the same answer.
			return result.code === "not_available" ? 404 : 400;
	}
};

/**
 * POST /api/world/query. The body is the `world.query` request; the Scope the
 * caller may read is bound by the host (`context`), never by the body.
 * Not mounted by default: the application decides to expose it.
 */
export function registerWorldQuery(
	app: Hono,
	query: WorldQuery,
	context: () => WorldQueryContext,
) {
	app.post("/api/world/query", async (c) => {
		const text = await c.req.text();
		if (new TextEncoder().encode(text).length > WORLD_QUERY_LIMITS.requestBytes)
			return c.json(
				{ status: "rejected", code: "limit_exceeded" } as const,
				400,
			);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return c.json(
				{ status: "rejected", code: "invalid_request" } as const,
				400,
			);
		}
		const result = await query.query(context(), body);
		return c.json(result, statusOf(result));
	});
}
export { registerWorldClaims } from "./claims";
