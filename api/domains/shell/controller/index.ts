import { z } from "zod";
import type { Context, Hono } from "hono";
import { parseJsonBody } from "../../../infrastructure/http";
import { startSchema, sizeSchema, inputSchema } from "../contracts";
import type { ShellService } from "../service";
const invalid = (c: Context) => c.json({ error: "invalid_shell_input" }, 400);
const options = { code: "invalid_shell_input" };
export function registerShell(app: Hono, service: ShellService) {
	app.get("/api/shell/sessions", (c) => c.json(service.list()));
	app.post("/api/shell/sessions", async (c) => {
		const p = await parseJsonBody(c, startSchema, options);
		return p.ok ? c.json(service.start(p.data), 201) : p.response;
	});
	for (const action of ["input", "resize", "restart"] as const)
		app.post(`/api/shell/sessions/:id/${action}`, async (c) => {
			const id = c.req.param("id");
			if (!z.uuid().safeParse(id).success) return invalid(c);
			if (action === "input") {
				const p = await parseJsonBody(c, inputSchema, options);
				if (!p.ok) return p.response;
				service.input(id, p.data.data);
				return c.body(null, 204);
			}
			const p = await parseJsonBody(c, sizeSchema, options);
			if (!p.ok) return p.response;
			if (action === "restart") return c.json(service.restart(id, p.data));
			service.resize(id, p.data);
			return c.body(null, 204);
		});
	app.get("/api/shell/sessions/:id/output", (c) => {
		const id = c.req.param("id");
		return z.uuid().safeParse(id).success
			? service.stream(id, c.req.raw.signal)
			: invalid(c);
	});
}
