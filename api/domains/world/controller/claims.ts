import type { Context, Hono } from "hono";
import type { WorldClaimError } from "../contracts/claims";
import type {
	ClaimResult,
	WorldClaims,
	WorldClaimsContext,
} from "../service/world-claims";

const statusOf = (code: WorldClaimError): 400 | 404 | 409 | 503 => {
	switch (code) {
		// Unknown, hidden, other Scope, closed gate, forgotten: ONE answer.
		case "not_found":
			return 404;
		case "world_disabled":
		case "revision_conflict":
		case "claim_not_changeable":
			return 409;
		case "world_unavailable":
			return 503;
		case "invalid_world_request":
		case "reason_source_unavailable":
			return 400;
	}
};

/**
 * The owner's claim list and explicit corrections (P5-02). Mounted only while
 * World is configured (protect or on); with World OFF the routes do not exist.
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
		return c.json(
			{
				error: result.code,
				...("reload" in result ? { reload: true } : {}),
			},
			statusOf(result.code),
		);
	};
	const body = (c: Context) => c.req.json().catch(() => null);

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
	app.post("/api/world/claims/correct", async (c) =>
		reply(c, await claims.correct(context(), await body(c))),
	);
	app.post("/api/world/claims/retract", async (c) =>
		reply(c, await claims.retract(context(), await body(c))),
	);
	app.post("/api/world/claims/forget", async (c) =>
		reply(c, await claims.forget(context(), await body(c))),
	);
}
