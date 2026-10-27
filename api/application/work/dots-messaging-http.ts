import type { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody, parseQuery, queryInt } from "../../infrastructure/http";
import {
	messagingSettingInput,
	messageConversationInput,
	sendMessageInput,
	cancelMessageInput,
} from "../../domains/dots";
import type { DotsMessages } from "./dots-messages";
const viewQuery = z.object({
	after: queryInt.default(0),
	limit: queryInt.default(50),
});
export function registerDotsMessaging(app: Hono, messages: DotsMessages) {
	app.put("/api/dots/connections/:id/messaging", async (c) => {
		const b = await parseJsonBody(c, messagingSettingInput, {
			code: "invalid_dots_input",
		});
		return b.ok
			? c.json(await messages.configure(c.req.param("id"), b.data))
			: b.response;
	});
	app.post("/api/dots/message-conversations", async (c) => {
		const b = await parseJsonBody(c, messageConversationInput, {
			code: "invalid_dots_input",
		});
		return b.ok ? c.json(await messages.open(b.data)) : b.response;
	});
	app.post("/api/dots/message-conversations/:id/messages", async (c) => {
		const b = await parseJsonBody(c, sendMessageInput, {
			code: "invalid_dots_input",
		});
		return b.ok
			? c.json(await messages.send(c.req.param("id"), b.data))
			: b.response;
	});
	app.get("/api/dots/message-conversations/:id", (c) => {
		const query = parseQuery(c, viewQuery, { code: "invalid_dots_cursor" });
		if (!query.ok) return query.response;
		return c.json(
			messages.view(c.req.param("id"), query.data.after, query.data.limit),
		);
	});
	app.post("/api/dots/messages/:id/cancel", async (c) => {
		const b = await parseJsonBody(c, cancelMessageInput, {
			code: "invalid_dots_input",
		});
		return b.ok
			? c.json(await messages.cancel(c.req.param("id"), b.data))
			: b.response;
	});
}
