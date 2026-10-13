import { limitConcurrency } from "../../../infrastructure/concurrency";
import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import { attachmentLimits } from "../contracts/attachments";
import type { Hono } from "hono";
import { historyReadInput, historySearchInput } from "../contracts";
import type { ConversationService } from "..";
export function registerConversation(app: Hono, service: ConversationService) {
	app.post(
		"/api/conversations/:id/attachments",
		limitConcurrency(2, "attachment_capacity"),
		async (c) => {
			const id = z.uuid().safeParse(c.req.query("requestId"));
			if (!id.success || !c.req.param("id") || c.req.param("id").length > 120)
				return c.json({ error: "invalid_attachment_input" }, 400);
			const bytes = await readBounded(c.req.raw.body, {
				limit: attachmentLimits.maxBytes + 16384,
				missing: "invalid_attachment_input",
				tooLarge: "image_too_large",
				signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
			});
			let form: FormData;
			try {
				form = await new Response(new Uint8Array(bytes), {
					headers: { "Content-Type": c.req.header("Content-Type") ?? "" },
				}).formData();
			} catch {
				return c.json({ error: "invalid_attachment_input" }, 400);
			}
			const file = form.get("file");
			if (!(file instanceof File) || [...form.keys()].length !== 1)
				return c.json({ error: "invalid_attachment_input" }, 400);
			return c.json(
				await service.uploadAttachment(c.req.param("id"), id.data, file),
				201,
			);
		},
	);
	app.get("/api/conversations/:id/attachments/:attachmentId/content", (c) => {
		const result = service.attachmentContent(
			c.req.param("id"),
			c.req.param("attachmentId"),
			c.req.query("preview") === "true",
		);
		return new Response(new Uint8Array(result.bytes), {
			headers: { "Content-Type": result.mime, "Cache-Control": "no-store" },
		});
	});
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
