import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseJsonBody } from "../../../infrastructure/http";
import {
	openInput,
	resolveInput,
	stageInput,
	id,
	errorStatus,
	ArchiveFailure,
} from "../contracts";
import type { MarkdownService } from "../service";

function failure(c: Context, error: unknown) {
	const code =
		error instanceof ArchiveFailure
			? error.code
			: error instanceof Error && Object.hasOwn(errorStatus, error.message)
				? error.message
				: "markdown_archive_unavailable";
	const status =
		error instanceof ArchiveFailure &&
		[400, 401, 403, 404, 409, 413, 422].includes(error.httpStatus ?? 0)
			? error.httpStatus!
			: (errorStatus[code as keyof typeof errorStatus] ?? 503);
	return c.json(
		{ error: code },
		status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 502 | 503,
	);
}
const signal = (c: Context) =>
	AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]);
const headers = { "Cache-Control": "no-store" };
export function registerMarkdown(app: Hono, service: MarkdownService) {
	app.use(
		"/api/markdown/*",
		bodyLimit({
			maxSize: 20 * 1024 * 1024,
			onError: (c) => c.json({ error: "payload_too_large" }, 413),
		}),
	);
	app.post("/api/markdown/inputs", async (c) => {
		const input = await parseJsonBody(c, stageInput, {
			code: "invalid_request",
		});
		if (!input.ok) return input.response;
		try {
			return c.json(await service.stage(input.data), 201, headers);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.get("/api/markdown/capabilities", async (c) => {
		try {
			return c.json(await service.capabilities(signal(c)), 200, headers);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.get("/api/markdown/library", async (c) => {
		try {
			return c.json(
				await service.library(signal(c), c.req.query("cursor")),
				200,
				headers,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.get("/api/markdown/remote/:id", async (c) => {
		const parsed = openInput.safeParse({ sourceId: c.req.param("id") });
		if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
		try {
			return c.json(
				await service.preview(parsed.data.sourceId, signal(c)),
				200,
				headers,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.post("/api/markdown/reconcile/:id", async (c) => {
		const parsed = id.safeParse(c.req.param("id"));
		if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
		try {
			return c.json(
				await service.reconcile(parsed.data, signal(c)),
				200,
				headers,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.post("/api/markdown/open", async (c) => {
		const input = await parseJsonBody(c, openInput, {
			code: "invalid_request",
		});
		if (!input.ok) return input.response;
		try {
			return c.json(
				await service.open(input.data.sourceId, signal(c), input.data),
				200,
				headers,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.post("/api/markdown/resolve", async (c) => {
		const input = await parseJsonBody(c, resolveInput, {
			code: "invalid_request",
		});
		if (!input.ok) return input.response;
		try {
			return c.json(
				await service.resolve(
					input.data.documentId,
					input.data.expectedRevision,
					input.data.etag,
				),
				200,
				headers,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
}
