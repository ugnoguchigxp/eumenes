import type { Hono } from "hono";
import { z } from "zod";
import { parseQuery, queryInt } from "../../../infrastructure/http";
import type { QueueService } from "../service";

const listQuery = z.object({
	scope: z.string().optional(),
	state: z.string().optional(),
	kind: z.string().optional(),
	subjectRef: z.string().optional(),
	cursor: z.string().optional(),
	limit: queryInt.pipe(z.number().min(1).max(100)).default(50),
});

export function registerQueue(app: Hono, service: QueueService) {
	app.get("/api/jobs", (c) => {
		const q = parseQuery(c, listQuery, { code: "invalid_limit" });
		if (!q.ok) return q.response;
		return c.json(
			service.list(
				{
					scope: q.data.scope,
					state: q.data.state,
					kind: q.data.kind,
					subjectRef: q.data.subjectRef,
				},
				q.data.cursor ?? null,
				q.data.limit,
			),
		);
	});
	app.get("/api/jobs/:id", (c) => {
		const job = service.getDto(c.req.param("id"));
		return job ? c.json(job) : c.json({ error: "not_found" }, 404);
	});
}
