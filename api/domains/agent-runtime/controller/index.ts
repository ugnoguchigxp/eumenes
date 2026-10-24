import type { Hono } from "hono";
import type { AgentRuntime } from "../service";
import { workQuery } from "../contracts/work-query";
export function registerAgentRuntime(
	app: Hono,
	service: AgentRuntime,
	cancelRoot: (rootRunId: string) => Promise<unknown>,
) {
	app.get("/api/agent-executions", (c) => {
		const conversationId = c.req.query("conversationId");
		if (!conversationId || conversationId.length > 120)
			throw new Error("invalid_conversation_id");
		return c.json(service.executions.list(conversationId));
	});
	// The agency's TODO view (spec agency-work-reports-design-2026-10-24): before /:id so it is not taken as an id.
	app.get("/api/agent-executions/work", (c) => {
		const conversationId = c.req.query("conversationId");
		if (!conversationId || conversationId.length > 120)
			throw new Error("invalid_conversation_id");
		if (c.req.query("state") !== undefined) {
			const parsed = workQuery.safeParse(c.req.query());
			if (!parsed.success) return c.json({ error: "invalid_work_query" }, 400);
			return c.json(
				service.executions.agencyWorkPage(conversationId, parsed.data),
			);
		}
		return c.json(service.executions.agencyWork(conversationId));
	});
	app.get("/api/agent-executions/:id", (c) => {
		const view = service.executions.get(c.req.param("id"));
		if (!view) throw new Error("execution_not_found");
		return c.json(view);
	});
	app.get("/api/agent-tasks", (c) => {
		const root = c.req.query("rootRunId");
		if (!root || root.length > 120) throw new Error("invalid_root_run_id");
		return c.json(service.list(root));
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
