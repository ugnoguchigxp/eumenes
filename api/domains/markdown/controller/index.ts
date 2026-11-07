import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseJsonBody } from "../../../infrastructure/http";
import { openInput, stageInput, id } from "../contracts";
import type { MarkdownService } from "../service";

function unavailable(c: Context, error: unknown) {
	if (error instanceof Error && error.message === "revision_conflict")
		return c.json({ error: "revision_conflict" }, 409);
	return c.json({ error: "markdown_archive_unavailable" }, 503);
}
export function registerMarkdown(app: Hono, service: MarkdownService) {
	app.use(
		"/api/markdown/*",
		bodyLimit({
			maxSize: 2 * 1024 * 1024,
			onError: (c) => c.json({ error: "payload_too_large" }, 413),
		}),
	);
	app.post("/api/markdown/inputs", async (c) => {
		const input = await parseJsonBody(c, stageInput, {
			code: "invalid_request",
		});
		if (!input.ok) return input.response;
		try {
			return c.json(await service.stage(input.data), 201, {
				"Cache-Control": "no-store",
			});
		} catch (error) {
			return unavailable(c, error);
		}
	});
	app.get("/api/markdown/library", async (c) => {
		try {
			return c.json(
				await service.library(
					AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
				),
				200,
				{ "Cache-Control": "no-store" },
			);
		} catch (error) {
			return unavailable(c, error);
		}
	});
	app.post("/api/markdown/reconcile/:id", async (c) => {
		const parsed = id.safeParse(c.req.param("id"));
		if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
		try {
			return c.json(
				await service.reconcile(
					parsed.data,
					AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
				),
				200,
				{ "Cache-Control": "no-store" },
			);
		} catch (error) {
			return unavailable(c, error);
		}
	});
	app.post("/api/markdown/open", async (c) => {
		const input = await parseJsonBody(c, openInput, {
			code: "invalid_request",
		});
		if (!input.ok) return input.response;
		try {
			return c.json(
				await service.open(
					input.data.sourceId,
					AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
				),
				200,
				{ "Cache-Control": "no-store" },
			);
		} catch (error) {
			return unavailable(c, error);
		}
	});
}
