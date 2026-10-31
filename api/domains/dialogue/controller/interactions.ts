import type { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody, parseQuery } from "../../../infrastructure/http";
import {
	interactionAnswer,
	interactionStatuses,
} from "../contracts/command-interactions";

import type { CommandInteractions } from "../service/command-interactions";
const listQuery = z.object({
	conversationId: z.string().min(1).max(120),
	status: z.enum(interactionStatuses).optional(),
});
/** The slice of the dialogue service the interaction routes use. */
type InteractionsService = {
	interactions: CommandInteractions;
};

/**
 * Questions a toolchain's sub-agent asked and their answers (spec 2026-10-13 §7).
 * - `GET  /api/toolchain-interactions?conversationId=&status=` -> 200 views (400 without a conversation)
 * - `POST /api/toolchain-interactions/:id/answers` -> 202 {interaction, runId, replay:false} | 200 replay
 *   | 400 body | 404 | 409 closed / stale question / revision / conflict / version | 410 expired | 422 answer
 */
export function registerCommandInteractions(
	app: Hono,
	service: InteractionsService,
) {
	app.get("/api/toolchain-interactions", (c) => {
		const query = parseQuery(c, listQuery);
		if (!query.ok) return query.response;
		return c.json(
			service.interactions.list({
				conversationId: query.data.conversationId,
				...(query.data.status ? { status: query.data.status } : {}),
			}),
		);
	});
	app.post("/api/toolchain-interactions/:id/answers", async (c) => {
		const parsed = await parseJsonBody(c, interactionAnswer);
		if (!parsed.ok) return parsed.response;
		const result = await service.interactions.answer(
			c.req.param("id"),
			parsed.data,
		);
		return c.json(result, result.replay ? 200 : 202);
	});
}
