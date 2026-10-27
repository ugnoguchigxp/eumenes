import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { parseQuery } from "../../../infrastructure/http";
import type { ActionRequests } from "../service/action-requests";
import { ActionRequestError } from "../service/action-types";

const MAX_BODY_BYTES = 32_768;
const eventId = z.uuid();
const artifactRevisionId = z
	.string()
	.regex(/^artifact:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/);
const sourceName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const targetRef = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const unsettledQuery = z.object({ status: z.literal("unsettled") });
const sourceQuery = z.object({ target: targetRef.optional() });

/**
 * UI action ledger and registered artifact endpoints (spec §6.2). The browser can only name an
 * artifact revision, a source and an action that the host registered; it never names an
 * operation, adapter, owner or scope.
 */
export function registerToolchainActions(app: Hono, service: ActionRequests) {
	// The body is bounded while it is read, not after it is in memory.
	app.use(
		"/api/toolchain-actions",
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: (c) => c.json({ error: "payload_too_large" }, 413),
		}),
	);
	app.post("/api/toolchain-actions", async (c) => {
		let raw: unknown;
		try {
			raw = JSON.parse(await c.req.text());
		} catch {
			return c.json({ error: "invalid_action_event" }, 400);
		}
		try {
			const { request, replay } = await service.submit(raw);
			if (replay) c.header("idempotent-replay", "true");
			// 202 only means "recorded, not settled"; it is never a confirmed acceptance.
			const settled =
				request.status === "accepted" || request.status === "rejected";
			return c.json(request, settled ? 200 : 202);
		} catch (error) {
			if (error instanceof ActionRequestError)
				return c.json(
					{
						error: error.code,
						...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
					},
					error.status,
				);
			throw error;
		}
	});
	app.get("/api/toolchain-actions", (c) => {
		const query = parseQuery(c, unsettledQuery, {
			code: "invalid_action_query",
		});
		if (!query.ok) return query.response;
		return c.json({ requests: service.unsettled() });
	});
	app.get("/api/toolchain-actions/:eventId", (c) => {
		if (!eventId.safeParse(c.req.param("eventId")).success)
			return c.json({ error: "invalid_action_event" }, 400);
		const request = service.get(c.req.param("eventId"));
		return request
			? c.json(request)
			: c.json({ error: "action_not_found" }, 404);
	});
	app.get("/api/toolchain-artifacts", (c) =>
		c.json({ artifacts: service.artifacts() }),
	);
	app.get("/api/toolchain-artifacts/:artifactRevisionId", (c) => {
		const id = artifactRevisionId.safeParse(c.req.param("artifactRevisionId"));
		if (!id.success) return c.json({ error: "invalid_artifact" }, 400);
		try {
			return c.json(service.artifact(id.data));
		} catch (error) {
			return refusal(c, error);
		}
	});
	app.get(
		"/api/toolchain-artifacts/:artifactRevisionId/sources/:source",
		(c) => {
			const id = artifactRevisionId.safeParse(
				c.req.param("artifactRevisionId"),
			);
			const source = sourceName.safeParse(c.req.param("source"));
			const target = parseQuery(c, sourceQuery, { code: "invalid_artifact" });
			if (!id.success || !source.success || !target.ok)
				return c.json({ error: "invalid_artifact" }, 400);
			const params = parseParams(c.req.query("params"));
			if (params === invalidParams)
				return c.json({ error: "invalid_params" }, 400);
			try {
				return c.json(
					service.source(id.data, source.data, target.data.target, params),
				);
			} catch (error) {
				return refusal(c, error);
			}
		},
	);
}

const MAX_PARAMS_BYTES = 4096;
const invalidParams = Symbol("invalid_params");
/** `params` is URL-encoded JSON (at most 4 KiB); the source's registered schema validates it. */
function parseParams(raw: string | undefined): unknown {
	if (raw === undefined) return undefined;
	if (new TextEncoder().encode(raw).length > MAX_PARAMS_BYTES)
		return invalidParams;
	try {
		return JSON.parse(raw);
	} catch {
		return invalidParams;
	}
}

function refusal(c: import("hono").Context, error: unknown) {
	if (error instanceof ActionRequestError)
		return c.json({ error: error.code }, error.status);
	throw error;
}
