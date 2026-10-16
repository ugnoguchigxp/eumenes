import type { Hono } from "hono";
import { z } from "zod";
import type { KanbanService } from "../service";

const limitSchema = z.coerce.number().int().min(1).max(50);
const DEFAULT_LIMIT = 20;
const idSchema = z.uuid();

/** The notice API of the task board (plan §3.12); card operations go through the toolchain. */
export function registerKanban(app: Hono, kanban: KanbanService) {
	app.get("/api/kanban/notices", (c) => {
		const raw = c.req.query("limit");
		const limit =
			raw === undefined ? DEFAULT_LIMIT : limitSchema.safeParse(raw);
		if (typeof limit !== "number" && !limit.success)
			return c.json({ error: "invalid_kanban_input" }, 400);
		return c.json(
			kanban.notices(typeof limit === "number" ? limit : limit.data),
		);
	});
	app.post("/api/kanban/notices/:id/read", async (c) => {
		const id = c.req.param("id");
		if (!idSchema.safeParse(id).success)
			throw new Error("kanban_notice_not_found");
		await kanban.readNotice(id);
		return c.body(null, 204);
	});
}
