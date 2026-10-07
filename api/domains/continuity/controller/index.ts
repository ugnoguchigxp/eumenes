import type { Context } from "hono";
import type { Hono } from "hono";
import { z } from "zod";
import { WriterBusyError } from "../../../infrastructure/sqlite";
import {
	ContinuityError,
	conversationIdSchema,
	createBookmarkRequestSchema,
	deactivateBookmarkRequestSchema,
	HISTORY_MAX_LIMIT,
	reviseBookmarkRequestSchema,
} from "../contracts";
import type { ContinuityService } from "../service";

const idParam = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9._:-]+$/);
const listQuerySchema = z.object({
	includeInactive: z.enum(["true", "false"]).optional(),
});
const historyQuerySchema = z.object({
	after: z.coerce.number().int().min(0).optional(),
	limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
});

class BadRequest extends Error {}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new BadRequest();
	return result.data;
}

async function body(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new BadRequest();
	}
}

export function registerContinuity(app: Hono, service: ContinuityService) {
	// Known errors are mapped here; unknown ones are rethrown to the host.
	const handle =
		(
			run: (c: Context) => unknown | Promise<unknown>,
			success: 200 | 201 = 200,
		) =>
		async (c: Context) => {
			try {
				return c.json((await run(c)) as Record<string, unknown>, success);
			} catch (error) {
				if (error instanceof BadRequest)
					return c.json({ error: "invalid_request" }, 400);
				if (error instanceof ContinuityError)
					return c.json({ error: error.code }, error.status);
				if (error instanceof WriterBusyError)
					return c.json({ error: "database_writer_queue_full" }, 503);
				throw error;
			}
		};
	const conversationId = (c: Context) =>
		parse(conversationIdSchema, c.req.param("id") ?? "");
	const bookmarkId = (c: Context) =>
		parse(idParam, c.req.param("bookmarkId") ?? "");
	const query = (c: Context, names: string[]) =>
		Object.fromEntries(
			names.flatMap((name) => {
				const value = c.req.query(name);
				return value === undefined ? [] : [[name, value]];
			}),
		);

	app.get(
		"/api/conversations/:id/bookmarks",
		handle((c) => {
			const id = conversationId(c);
			const q = parse(listQuerySchema, query(c, ["includeInactive"]));
			return service.list(id, {
				includeInactive: q.includeInactive === "true",
			});
		}),
	);
	app.post(
		"/api/conversations/:id/bookmarks",
		handle(async (c) => {
			const id = conversationId(c);
			const input = parse(createBookmarkRequestSchema, await body(c));
			return service.create(id, input);
		}, 201),
	);
	app.post(
		"/api/conversations/:id/bookmarks/:bookmarkId/revise",
		handle(async (c) => {
			const id = conversationId(c);
			const bid = bookmarkId(c);
			const input = parse(reviseBookmarkRequestSchema, await body(c));
			return service.revise(id, bid, input);
		}),
	);
	app.post(
		"/api/conversations/:id/bookmarks/:bookmarkId/deactivate",
		handle(async (c) => {
			const id = conversationId(c);
			const bid = bookmarkId(c);
			const input = parse(deactivateBookmarkRequestSchema, await body(c));
			return service.deactivate(id, bid, input);
		}),
	);
	app.get(
		"/api/conversations/:id/bookmarks/:bookmarkId/history",
		handle((c) => {
			const id = conversationId(c);
			const bid = bookmarkId(c);
			const q = parse(historyQuerySchema, query(c, ["after", "limit"]));
			return service.history(id, bid, q);
		}),
	);
	app.get(
		"/api/conversations/:id/bookmarks/:bookmarkId/source",
		handle((c) => service.source(conversationId(c), bookmarkId(c))),
	);
}
