import type { Hono } from "hono";
import { parseQuery, queryInt } from "../../../infrastructure/http";
import { z } from "zod";
import type { KanbanService } from "../service";

const noticesQuery = z.object({
	limit: queryInt.pipe(z.number().min(1).max(50)).default(20),
});
const idSchema = z.uuid();

/** The notice API of the task board (plan §3.12); card operations go through the toolchain. */
export function registerKanban(app: Hono, kanban: KanbanService) {
	app.get("/api/kanban/notices", (c) => {
		const query = parseQuery(c, noticesQuery, { code: "invalid_kanban_input" });
		if (!query.ok) return query.response;
		return c.json(kanban.notices(query.data.limit));
	});
	app.post("/api/kanban/notices/:id/read", async (c) => {
		const id = c.req.param("id");
		if (!idSchema.safeParse(id).success)
			throw new Error("kanban_notice_not_found");
		await kanban.readNotice(id);
		return c.body(null, 204);
	});
}
