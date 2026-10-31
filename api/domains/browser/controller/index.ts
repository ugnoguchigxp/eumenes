import type { Context, Hono } from "hono";
import { z } from "zod";
import { errorStatus, settingSave } from "../contracts";
import { parseJsonBody, parseQuery } from "../../../infrastructure/http";
import type { BrowserService } from "../service";

const noStore = { "Cache-Control": "no-store" };
/** Bun passes its server as the Hono env; only the per-request idle timeout is used. */
type BunServer = { timeout?: (request: Request, seconds: number) => void };

const tasksQuery = z.object({ conversationId: z.string().min(1).max(512) });

/** A code with a status of its own reaches the application's error handler; anything else is `browser_failed`. */
function failure(c: Context, e: unknown) {
	if (e instanceof Error && Object.hasOwn(errorStatus, e.message)) throw e;
	return c.json({ error: "browser_failed" }, 500);
}

/** Read APIs and the Brave path setting; writes of tasks and captures go through the shared toolchain actions. */
export function registerBrowser(app: Hono, s: BrowserService, owner: string) {
	const id = (c: Context) => z.uuid().safeParse(c.req.param("id"));
	app.get("/api/browser/setting", async (c) =>
		c.json(
			{
				...s.setting.get(),
				suggestedPath: await s.setting.suggest(),
				canBrowse: s.setting.canBrowse,
			},
			200,
			noStore,
		),
	);
	app.put("/api/browser/setting", async (c) => {
		const body = await parseJsonBody(c, settingSave, {
			code: "invalid_browser_setting",
		});
		if (!body.ok) return body.response;
		try {
			return c.json(
				await s.setting.save(body.data.executablePath),
				200,
				noStore,
			);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.post("/api/browser/setting/browse", async (c) => {
		// The response waits for the user to close the dialog, longer than the server's idle timeout.
		(c.env as BunServer | undefined)?.timeout?.(c.req.raw, 0);
		try {
			return c.json(await s.setting.browse(), 200, noStore);
		} catch (e) {
			if (e instanceof Error && e.message === "browser_browse_failed")
				return c.json({ error: e.message }, 500);
			return failure(c, e);
		}
	});
	app.get("/api/browser/tabs", async (c) =>
		c.json({ tabs: await s.refreshTabs() }, 200, noStore),
	);
	app.get("/api/browser/tasks", (c) => {
		const query = parseQuery(c, tasksQuery, {
			code: "invalid_browser_conversation",
		});
		if (!query.ok) return query.response;
		return c.json(
			{ tasks: s.listTasks(owner, query.data.conversationId) },
			200,
			noStore,
		);
	});
	app.get("/api/browser/histories", (c) =>
		c.json({ histories: s.listHistories(owner) }, 200, noStore),
	);
	app.get("/api/browser/histories/:id", (c) => {
		const h = id(c);
		if (!h.success) return c.json({ error: "invalid_browser_id" }, 400);
		try {
			return c.json({ history: s.historyDetail(owner, h.data) }, 200, noStore);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.get("/api/browser/captures/:id/content", async (c) => {
		const k = id(c);
		if (!k.success) return c.json({ error: "invalid_browser_id" }, 400);
		try {
			const content = await s.captureContent(owner, k.data);
			return new Response(new Uint8Array(content.bytes), {
				headers: {
					"Content-Type": content.mime,
					// The image shows what was on a page: no cache keeps a copy.
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
					"Content-Disposition": `inline; filename="capture-${k.data}.webp"`,
				},
			});
		} catch (e) {
			return failure(c, e);
		}
	});
}
