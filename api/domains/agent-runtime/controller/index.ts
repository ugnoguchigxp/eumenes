import type { Hono } from "hono";
import { z } from "zod";
import { parseQuery } from "../../../infrastructure/http";
import type { AgentRuntime } from "../service";
const executionsQuery = z.object({
	conversationId: z.string().min(1).max(120),
});
const tasksQuery = z.object({ rootRunId: z.string().min(1).max(120) });
export function registerAgentRuntime(
	app: Hono,
	service: AgentRuntime,
	cancelRoot: (rootRunId: string) => Promise<unknown>,
) {
	app.get("/api/agent-executions", (c) => {
		const query = parseQuery(c, executionsQuery, {
			code: "invalid_conversation_id",
		});
		if (!query.ok) return query.response;
		return c.json(service.executions.list(query.data.conversationId));
	});
	app.get("/api/agent-executions/:id", (c) => {
		const view = service.executions.get(c.req.param("id"));
		if (!view) throw new Error("execution_not_found");
		return c.json(view);
	});
	app.get("/api/agent-tasks", (c) => {
		const query = parseQuery(c, tasksQuery, { code: "invalid_root_run_id" });
		if (!query.ok) return query.response;
		return c.json(service.list(query.data.rootRunId));
	});
	app.get("/api/agent-tasks/:id/report", (c) =>
		c.json(service.report(c.req.param("id"))),
	);
	app.get("/api/agent-tasks/:id", (c) => {
		const task = service.get(c.req.param("id"));
		if (!task) throw new Error("task_not_found");
		return c.json(task);
	});
	app.post("/api/agent-tasks/:id/cancel", async (c) => {
		const task = service.get(c.req.param("id"));
		if (!task) throw new Error("task_not_found");
		await cancelRoot(task.rootRunId);
		return c.json(service.get(task.id));
	});
}
