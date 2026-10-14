import type { Context, Hono } from "hono";
import { parseJsonBody } from "../../infrastructure/http";
import {
	terminalIdSchema,
	terminalInputSchema,
	terminalSizeSchema,
	terminalStartSchema,
} from "./contracts";
import type { TerminalsService } from "./service";

const idOf = (c: Context) => {
	const id = c.req.param("id");
	return id && terminalIdSchema.safeParse(id).success ? id : undefined;
};
const invalid = (c: Context) =>
	c.json({ error: "invalid_terminal_input" }, 400);
const options = { code: "invalid_terminal_input" };

export function registerTerminals(app: Hono, service: TerminalsService) {
	app.get("/api/terminals", (c) => c.json(service.list()));
	app.post("/api/terminals", async (c) => {
		const parsed = await parseJsonBody(c, terminalStartSchema, options);
		if (!parsed.ok) return parsed.response;
		return c.json(service.start(parsed.data), 201);
	});
	app.post("/api/terminals/:id/input", async (c) => {
		const id = idOf(c);
		if (!id) return invalid(c);
		const parsed = await parseJsonBody(c, terminalInputSchema, options);
		if (!parsed.ok) return parsed.response;
		service.input(id, parsed.data.data);
		return c.body(null, 204);
	});
	app.post("/api/terminals/:id/resize", async (c) => {
		const id = idOf(c);
		if (!id) return invalid(c);
		const parsed = await parseJsonBody(c, terminalSizeSchema, options);
		if (!parsed.ok) return parsed.response;
		service.resize(id, parsed.data);
		return c.body(null, 204);
	});
	app.post("/api/terminals/:id/restart", async (c) => {
		const id = idOf(c);
		if (!id) return invalid(c);
		const parsed = await parseJsonBody(c, terminalSizeSchema, options);
		if (!parsed.ok) return parsed.response;
		return c.json(service.restart(id, parsed.data));
	});
	app.delete("/api/terminals/:id", (c) => {
		const id = idOf(c);
		if (!id) return invalid(c);
		service.remove(id);
		return c.body(null, 204);
	});
	app.get("/api/terminals/:id/output", (c) => {
		const id = idOf(c);
		if (!id) return invalid(c);
		return service.stream(id, c.req.raw.signal);
	});
}
