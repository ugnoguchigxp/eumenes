import type { Hono } from "hono";
import type { DoclingService } from "../service";

export function registerDocling(app: Hono, docling: DoclingService) {
	app.get("/api/docling/status", (c) =>
		c.json(docling.status(), 200, { "Cache-Control": "no-store" }),
	);
	for (const path of ["ready", "ui-tickets"] as const)
		app.post(`/api/docling/${path}`, async (c) => {
			// Bun passes its Server to Hono as env. app.request() fixtures have no network timeout.
			const server = c.env as
				| { timeout?: (request: Request, seconds: number) => void }
				| undefined;
			server?.timeout?.(c.req.raw, 200);
			const value =
				path === "ready"
					? await docling.ready(c.req.raw.signal)
					: await docling.ticket(c.req.raw.signal);
			return c.json(value, 200, {
				"Cache-Control": "no-store",
			});
		});
}
