import type { Hono } from "hono";
import { historyReadInput, historySearchInput } from "../contracts";
import type { ConversationService } from "..";
export function registerConversation(app: Hono, service: ConversationService) {
	app.get("/api/conversations/:id", (c) =>
		c.json(service.get(c.req.param("id"))),
	);
	for (const operation of ["search", "read"] as const) {
		app.post(`/api/conversations/:id/history/${operation}`, async (c) => {
			const input = (
				operation === "search" ? historySearchInput : historyReadInput
			).safeParse(await c.req.json().catch(() => null));
			if (!input.success)
				return c.json({ error: "invalid_history_input" }, 400);
			try {
				return c.json(
					operation === "search"
						? service.searchHistory(c.req.param("id"), input.data)
						: service.readHistory(c.req.param("id"), input.data),
				);
			} catch (e) {
				const code = e instanceof Error ? e.message : "history_unavailable";
				return c.json(
					{
						error: [
							"source_expired",
							"history_cursor_stale",
							"history_ref_invalid",
							"history_cursor_conditions",
							"history_capacity",
							"history_source_unavailable",
						].includes(code)
							? code
							: "history_unavailable",
					},
					409,
				);
			}
		});
	}
}
