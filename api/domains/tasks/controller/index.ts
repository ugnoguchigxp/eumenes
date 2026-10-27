import type { Hono } from "hono";
import { z } from "zod";
import { parseQuery, queryInt } from "../../../infrastructure/http";
import { readBounded } from "../../../infrastructure/bounded-read";
import { createTaskSchema, taskListQuerySchema } from "../contracts";
import type { TasksService } from "../service";

async function body(c: { req: { raw: Request } }) {
	const bytes = await readBounded(c.req.raw.body, {
		limit: 64 * 1024,
		tooLarge: "payload_too_large",
		missing: "invalid_task_input",
		signal: c.req.raw.signal,
	});
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new Error("invalid_task_input");
	}
}
const eventsQuery = z.object({
	cursor: z.string().default("0"),
	limit: queryInt.default(50),
});
export function registerTasks(app: Hono, tasks: TasksService) {
	app.post("/api/tasks", async (c) => {
		const parsed = createTaskSchema.safeParse(await body(c));
		if (!parsed.success) return c.json({ error: "invalid_task_input" }, 400);
		return c.json(await tasks.create(parsed.data), 202);
	});
	app.get("/api/tasks", (c) => {
		const parsed = parseQuery(c, taskListQuerySchema, {
			code: "invalid_task_query",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(tasks.list(parsed.data));
	});
	app.get("/api/tasks/:id", (c) => c.json(tasks.get(c.req.param("id"))));
	app.get("/api/tasks/:id/events", (c) => {
		const query = parseQuery(c, eventsQuery, { code: "invalid_cursor" });
		if (!query.ok) return query.response;
		return c.json(
			tasks.events(c.req.param("id"), query.data.cursor, query.data.limit),
		);
	});
	for (const op of ["start", "amend", "answers", "stop", "forget"] as const)
		app.post(`/api/tasks/:id/${op}`, async (c) => {
			const data = await body(c);
			const taskId = c.req.param("id");
			const method = op === "answers" ? tasks.answer : tasks[op];
			return c.json(await method(taskId, data), 202);
		});
}
