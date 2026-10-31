import type { Hono } from "hono";
import { isCapacityBusy, LARM_CAPACITY_RETRY_MS } from "../../larm";
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
			try {
				const value =
					path === "ready"
						? await docling.ready(c.req.raw.signal)
						: await docling.ticket(c.req.raw.signal);
				return c.json(value, 200, {
					"Cache-Control": "no-store",
				});
			} catch (error) {
				// LARM has no free memory: the Web screen sends the same request again later.
				if (!isCapacityBusy(error)) throw error;
				return c.json(
					{
						error: error.message,
						retryAfterMs: error.retryAfterMs ?? LARM_CAPACITY_RETRY_MS,
					},
					503,
					{ "Cache-Control": "no-store" },
				);
			}
		});
}
