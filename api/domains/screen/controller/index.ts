import type { Hono } from "hono";
import { parseJsonBody } from "../../../infrastructure/http";
import { screenReceiptSchema, type ScreenCommandsResponse } from "../contracts";
import type { ScreenService } from "../service";

const integer = (value: string | undefined, fallback: number) => {
	if (value === undefined) return fallback;
	return /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
};

export function registerScreen(app: Hono, service: ScreenService) {
	app.get("/api/screen/commands", (c) => {
		const conversationId = c.req.query("conversationId")?.trim();
		const after = integer(c.req.query("after"), 0);
		if (!conversationId || Number.isNaN(after))
			return c.json({ error: "invalid_screen_query" }, 400);
		const body: ScreenCommandsResponse = {
			commands: service.pendingAfter(conversationId, after),
		};
		return c.json(body);
	});
	app.post("/api/screen/commands/:seq/receipt", async (c) => {
		const seq = integer(c.req.param("seq"), Number.NaN);
		if (Number.isNaN(seq) || seq < 1)
			return c.json({ error: "invalid_screen_receipt" }, 400);
		const parsed = await parseJsonBody(c, screenReceiptSchema, {
			code: "invalid_screen_receipt",
		});
		if (!parsed.ok) return parsed.response;
		const result = await service.receipt(seq, parsed.data.outcome);
		if (result.ok) return c.json(result);
		return c.json(result, result.code === "command_not_found" ? 404 : 409);
	});
}
