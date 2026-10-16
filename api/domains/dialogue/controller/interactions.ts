import type { Hono } from "hono";
import { parseJsonBody } from "../../../infrastructure/http";
import {
	interactionAnswer,
	interactionCancel,
	interactionStatuses,
	type InteractionStatus,
} from "../contracts/command-interactions";

import type { CommandInteractions } from "../service/command-interactions";
/** The slice of the dialogue service the interaction routes use. */
type InteractionsService = {
	interactions: CommandInteractions;
};

/** HTTP status of each code the interaction operations throw; unknown codes stay 500. */
const interactionErrorStatus = {
	interaction_not_found: 404,
	interaction_closed: 409,
	interaction_expired: 410,
	question_stale: 409,
	revision_conflict: 409,
	request_conflict: 409,
	version_invalidated: 409,
	invalid_answer: 422,
	interaction_body_too_large: 413,
	interaction_capacity: 429,
	queue_full: 503,
	toolchain_unavailable: 503,
} as const;

function errorResponse(
	c: import("hono").Context,
	error: unknown,
): Response | never {
	const code = error instanceof Error ? error.message : "";
	const status = Object.hasOwn(interactionErrorStatus, code)
		? interactionErrorStatus[code as keyof typeof interactionErrorStatus]
		: undefined;
	if (!status) throw error;
	return c.json({ error: code }, status);
}

/**
 * Questions a toolchain's sub-agent asked and their answers (spec 2026-10-13 §7).
 * - `GET  /api/toolchain-interactions?conversationId=&status=` -> 200 views (400 without a conversation)
 * - `GET  /api/toolchain-interactions/:id` -> 200 view | 404
 * - `POST /api/toolchain-interactions/:id/answers` -> 202 {interaction, runId, replay:false} | 200 replay
 *   | 400 body | 404 | 409 closed / stale question / revision / conflict / version | 410 expired | 422 answer
 * - `POST /api/toolchain-interactions/:id/cancel` -> 200 view | 400 | 404 | 409
 */
export function registerCommandInteractions(
	app: Hono,
	service: InteractionsService,
) {
	app.get("/api/toolchain-interactions", (c) => {
		const conversationId = c.req.query("conversationId");
		const status = c.req.query("status");
		if (
			!conversationId ||
			conversationId.length > 120 ||
			(status !== undefined &&
				!(interactionStatuses as readonly string[]).includes(status))
		)
			return c.json({ error: "invalid_input" }, 400);
		return c.json(
			service.interactions.list({
				conversationId,
				...(status ? { status: status as InteractionStatus } : {}),
			}),
		);
	});
	app.get("/api/toolchain-interactions/:id", (c) => {
		const found = service.interactions.get(c.req.param("id"));
		return found
			? c.json(found)
			: c.json({ error: "interaction_not_found" }, 404);
	});
	app.post("/api/toolchain-interactions/:id/answers", async (c) => {
		const parsed = await parseJsonBody(c, interactionAnswer);
		if (!parsed.ok) return parsed.response;
		try {
			const result = await service.interactions.answer(
				c.req.param("id"),
				parsed.data,
			);
			return c.json(result, result.replay ? 200 : 202);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
	app.post("/api/toolchain-interactions/:id/cancel", async (c) => {
		const parsed = await parseJsonBody(c, interactionCancel);
		if (!parsed.ok) return parsed.response;
		try {
			return c.json(
				await service.interactions.cancel(c.req.param("id"), parsed.data),
			);
		} catch (error) {
			return errorResponse(c, error);
		}
	});
}
