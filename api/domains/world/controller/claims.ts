import type { Context, Hono } from "hono";
import type { WorldClaimError } from "../contracts/claims";
import type {
	ClaimResult,
	WorldClaims,
	WorldClaimsContext,
} from "../service/world-claims";

const statusOf = (code: WorldClaimError): 404 | 409 | 503 => {
	switch (code) {
		// Unknown, hidden, other Scope, closed gate, forgotten: ONE answer.
		case "not_found":
			return 404;
		case "world_disabled":
			return 409;
		case "world_unavailable":
			return 503;
	}
};

/**
 * The owner's claim list, view only: claims are kept by the memory steward, the owner can look but not
 * change them (plan G3). Mounted only while World is configured (protect or on); with World OFF the routes
 * do not exist.
 * The Scope the caller may use is bound by the host (`context`), never by the
 * body or the query string.
 */
export function registerWorldClaims(
	app: Hono,
	claims: WorldClaims,
	context: () => WorldClaimsContext,
) {
	type Reply = ClaimResult<unknown>;
	const reply = (c: Context, result: Reply) => {
		if (result.status === "ok") return c.json(result.value);
		return c.json({ error: result.code }, statusOf(result.code));
	};

	app.get("/api/world/status", (c) => c.json(claims.status(context())));
	app.get("/api/world/claims", (c) => {
		const scopeKey = c.req.query("scopeKey");
		return reply(
			c,
			claims.list(context(), scopeKey === undefined ? {} : { scopeKey }),
		);
	});
	app.get("/api/world/claims/:id", (c) => {
		const scopeKey = c.req.query("scopeKey");
		return reply(
			c,
			claims.detail(context(), {
				...(scopeKey === undefined ? {} : { scopeKey }),
				claimId: c.req.param("id"),
			}),
		);
	});
	app.get("/api/world/forgets", (c) => {
		const scopeKey = c.req.query("scopeKey");
		return reply(
			c,
			claims.forgets(context(), scopeKey === undefined ? {} : { scopeKey }),
		);
	});
}
