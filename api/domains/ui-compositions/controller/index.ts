import type { Hono } from "hono";
import type { UiCompositionsService } from "../service";

/** Authenticated reads for the workshop's live generation status and saved artwork. */
export function registerUiCompositions(
	app: Hono,
	service: UiCompositionsService,
) {
	app.get("/api/ui-compositions", (c) =>
		c.json({ items: service.list() }, 200, { "Cache-Control": "no-store" }),
	);
	app.get("/api/ui-compositions/:id", (c) => {
		const item = service.get(c.req.param("id"));
		return item
			? c.json(item, 200, { "Cache-Control": "no-store" })
			: c.json({ error: "ui_project_not_found" }, 404);
	});
}
