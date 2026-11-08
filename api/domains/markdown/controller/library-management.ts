import { z } from "zod";
import type { Hono, Context } from "hono";
import { parseJsonBody, parseQuery } from "../../../infrastructure/http";
import { ArchiveFailure, errorStatus } from "../contracts";
import { manageInput } from "../contracts/library";
import type { MarkdownService } from "../service";
const signal = (c: Context) =>
	AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(190000)]);
function failed(c: Context, e: unknown) {
	const code =
		e instanceof ArchiveFailure
			? e.code
			: e instanceof Error && Object.hasOwn(errorStatus, e.message)
				? e.message
				: "markdown_archive_unavailable";
	const status =
		e instanceof ArchiveFailure
			? e.httpStatus
			: errorStatus[code as keyof typeof errorStatus];
	return c.json(
		{ error: code },
		([400, 401, 403, 404, 409, 412, 413, 415, 422, 428, 503].includes(
			status ?? 0,
		)
			? status
			: 503) as 400 | 401 | 403 | 404 | 409 | 412 | 413 | 415 | 422 | 428 | 503,
	);
}
export function registerLibraryManagement(app: Hono, service: MarkdownService) {
	app.post("/api/markdown/management-inputs", async (c) => {
		const input = await parseJsonBody(c, manageInput, {
			code: "invalid_request",
		});
		if (!input.ok) return input.response;
		try {
			return c.json(await service.stageManagement(input.data), 201, {
				"Cache-Control": "no-store",
			});
		} catch (e) {
			return failed(c, e);
		}
	});

	app.get("/api/markdown/files", async (c) => {
		const q = parseQuery(
			c,
			z.object({
				namespace: z.string().min(1),
				path: z.string().default(""),
				cursor: z.string().optional(),
			}),
			{ code: "invalid_request" },
		);
		if (!q.ok) return q.response;
		try {
			return c.json(await service.files(q.data, signal(c)), 200, {
				"Cache-Control": "no-store",
			});
		} catch (e) {
			return failed(c, e);
		}
	});
	app.get("/api/markdown/management", async (c) => {
		try {
			return c.json(await service.operations(), 200, {
				"Cache-Control": "no-store",
			});
		} catch (e) {
			return failed(c, e);
		}
	});
	app.post("/api/markdown/management", async (c) => {
		const input = await parseJsonBody(
			c,
			z.union([manageInput, z.object({ stageId: z.uuid() })]),
			{
				code: "invalid_request",
			},
		);
		if (!input.ok) return input.response;
		try {
			const value =
				"stageId" in input.data
					? await service.manageStaged(input.data.stageId, signal(c))
					: input.data;
			return c.json(
				await service.manage(value.requestId, value.command, signal(c)),
				200,
				{ "Cache-Control": "no-store" },
			);
		} catch (e) {
			return failed(c, e);
		}
	});
	app.post("/api/markdown/management/:id/check", async (c) => {
		const id = z.uuid().safeParse(c.req.param("id"));
		if (!id.success) return c.json({ error: "invalid_request" }, 400);
		try {
			return c.json(await service.check(id.data, signal(c)), 200, {
				"Cache-Control": "no-store",
			});
		} catch (e) {
			return failed(c, e);
		}
	});
}
