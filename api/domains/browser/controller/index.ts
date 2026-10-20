import type { Context, Hono } from "hono";
import { z } from "zod";
import { settingSave } from "../contracts";
import type { BrowserService } from "../service";

const noStore = { "Cache-Control": "no-store" };
/** Bun passes its server as the Hono env; only the per-request idle timeout is used. */
type BunServer = { timeout?: (request: Request, seconds: number) => void };
const notFound = new Set([
	"browser_task_not_found",
	"browser_capture_not_found",
]);
const conflict = new Set(["browser_capture_not_ready"]);

function failure(c: Context, e: unknown) {
	const code = e instanceof Error ? e.message : "";
	if (notFound.has(code)) return c.json({ error: code }, 404);
	if (conflict.has(code)) return c.json({ error: code }, 409);
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
		const body = settingSave.safeParse(await c.req.json().catch(() => null));
		if (!body.success) return c.json({ error: "invalid_browser_setting" }, 400);
		try {
			return c.json(
				await s.setting.save(body.data.executablePath),
				200,
				noStore,
			);
		} catch (e) {
			if (e instanceof Error && e.message === "browser_executable_invalid")
				return c.json({ error: "browser_executable_invalid" }, 400);
			return failure(c, e);
		}
	});
	app.post("/api/browser/setting/browse", async (c) => {
		// The response waits for the user to close the dialog, longer than the server's idle timeout.
		(c.env as BunServer | undefined)?.timeout?.(c.req.raw, 0);
		try {
			return c.json(await s.setting.browse(), 200, noStore);
		} catch (e) {
			const code = e instanceof Error ? e.message : "";
			if (code === "browser_executable_invalid")
				return c.json({ error: code }, 400);
			if (code === "browser_browse_busy") return c.json({ error: code }, 409);
			if (code === "browser_browse_unsupported")
				return c.json({ error: code }, 501);
			if (code === "browser_browse_failed") return c.json({ error: code }, 500);
			return failure(c, e);
		}
	});
	app.get("/api/browser/connection", (c) =>
		c.json(s.connection(), 200, noStore),
	);
	app.get("/api/browser/tabs", async (c) =>
		c.json({ tabs: await s.refreshTabs() }, 200, noStore),
	);
	app.get("/api/browser/tasks", (c) => {
		const conversationId = z
			.string()
			.min(1)
			.max(512)
			.safeParse(c.req.query("conversationId"));
		if (!conversationId.success)
			return c.json({ error: "invalid_browser_conversation" }, 400);
		return c.json(
			{ tasks: s.listTasks(owner, conversationId.data) },
			200,
			noStore,
		);
	});
	app.get("/api/browser/tasks/:id", (c) => {
		const t = id(c);
		if (!t.success) return c.json({ error: "invalid_browser_id" }, 400);
		try {
			return c.json(s.taskStatus(owner, t.data), 200, noStore);
		} catch (e) {
			return failure(c, e);
		}
	});
	app.get("/api/browser/captures", (c) =>
		c.json({ captures: s.listCaptures(owner) }, 200, noStore),
	);
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
