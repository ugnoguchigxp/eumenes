import type { Hono } from "hono";
import type { ConversationService } from "..";
export function registerConversation(app: Hono, service: ConversationService) {
	app.get("/api/conversations/:id", (c) =>
		c.json(service.get(c.req.param("id"))),
	);
}
