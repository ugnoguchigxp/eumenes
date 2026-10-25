import type { Hono } from "hono";
import type { DoclingService } from "../service";

export function registerDocling(app: Hono, docling: DoclingService) {
	app.get("/api/docling/status", (c) =>
		c.json(docling.status(), 200, { "Cache-Control": "no-store" }),
	);
	app.post("/api/docling/ui-tickets", async (c) => {
		// Bun passes its Server to Hono as env. app.request() fixtures have no network timeout.
		const server = c.env as
			| { timeout?: (request: Request, seconds: number) => void }
			| undefined;
		server?.timeout?.(c.req.raw, 200);
		return c.json(await docling.ticket(c.req.raw.signal), 200, {
			"Cache-Control": "no-store",
		});
	});
}
