import type { Hono, Context } from "hono";
import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import type { ExcalidrawService } from "../service";
async function body(request: Request) {
	return JSON.parse(
		new TextDecoder().decode(
			await readBounded(request.body, {
				limit: 17 * 1024 ** 2,
				missing: "invalid_body",
				tooLarge: "invalid_body_size",
				signal: request.signal,
			}),
		),
	);
}
export function registerExcalidraw(app: Hono, s: ExcalidrawService) {
	function safe(handler: (c: Context) => Response | Promise<Response>) {
		return async (c: Context) => {
			try {
				return await handler(c);
			} catch (e) {
				const message = e instanceof Error ? e.message : "";
				return c.json(
					{
						error:
							e instanceof z.ZodError
								? "invalid_excalidraw_input"
								: /^[a-z_0-9]+$/.test(message)
									? message
									: "excalidraw_unavailable",
						...(e instanceof z.ZodError
							? {
									issues: e.issues.map((i) => ({ path: i.path, code: i.code })),
								}
							: {}),
					},
					e instanceof z.ZodError || e instanceof SyntaxError
						? 400
						: message.endsWith("not_found")
							? 404
							: message.includes("conflict")
								? 409
								: message === "invalid_body_size"
									? 413
									: 502,
				);
			}
		};
	}

	app.get(
		"/api/excalidraw/references",
		safe((c) => c.json(s.list(c.req.query("conversationId") ?? "main"))),
	);
	app.post(
		"/api/excalidraw/sessions",
		safe(async (c) => c.json(await s.session(await body(c.req.raw)), 202)),
	);
	app.get(
		"/api/excalidraw/sessions/:id",
		safe((c) => {
			const value = s.get(z.uuid().parse(c.req.param("id")));
			return value
				? c.json(value)
				: c.json({ error: "excalidraw_session_not_found" }, 404);
		}),
	);
	app.post(
		"/api/excalidraw/sessions/:id/reconnect",
		safe(async (c) =>
			c.json(await s.reconnect(z.uuid().parse(c.req.param("id"))), 202),
		),
	);
	app.post(
		"/api/excalidraw/sessions/:id/activity",
		safe(async (c) =>
			c.json(await s.activity(z.uuid().parse(c.req.param("id")))),
		),
	);
	app.delete(
		"/api/excalidraw/sessions/:id",
		safe(async (c) => {
			await s.release(z.uuid().parse(c.req.param("id")));
			return c.body(null, 204);
		}),
	);
	app.get(
		"/api/excalidraw/sessions/:id/document",
		safe(async (c) =>
			c.json(
				await s.document(
					z.uuid().parse(c.req.param("id")),
					AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(180000)]),
				),
			),
		),
	);
	app.put(
		"/api/excalidraw/sessions/:id/document",
		safe(async (c) => {
			const key = c.req.header("Idempotency-Key");
			if (!key || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key))
				return c.json({ error: "invalid_idempotency_key" }, 400);
			return c.json(
				await s.save(
					z.uuid().parse(c.req.param("id")),
					await body(c.req.raw),
					key,
					AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(180000)]),
				),
			);
		}),
	);
}
