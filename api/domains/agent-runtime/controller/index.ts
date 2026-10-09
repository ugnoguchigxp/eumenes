import type { Hono } from "hono";
import type { AgentRuntime } from "../service";
export function registerAgentRuntime(
	app: Hono,
	service: AgentRuntime,
	cancelRoot: (rootRunId: string) => Promise<unknown>,
) {
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
