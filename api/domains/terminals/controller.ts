import type { Context, Hono } from "hono";
import { readBounded } from "../../infrastructure/bounded-read";
import { parseJsonBody } from "../../infrastructure/http";
import { HOOK_PATH, HOOK_TOKEN_HEADER, hookPayloadSchema } from "./hooks";
import {
	terminalIdSchema,
	terminalInputSchema,
	terminalSizeSchema,
	terminalStartSchema,
} from "./contracts";
import type { TerminalsService } from "./service";

/** Bytes of one hook body read at most. */
const HOOK_BODY_LIMIT = 4 * 1024 * 1024;

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
	// Claude Code's own hooks (outside /api: the child never holds the API token). The run's
	// token authenticates; the body is bounded and only the event and last answer are read.
	app.post(`${HOOK_PATH}/:id`, async (c) => {
		const id = idOf(c);
		const token = c.req.header(HOOK_TOKEN_HEADER);
		if (!id || !token) return c.json({ error: "terminal_hook_forbidden" }, 403);
		// The token is checked before anything of the body is read.
		service.verifyHook(id, token);
		let payload: unknown;
		try {
			const bytes = await readBounded(c.req.raw.body, {
				// PostToolUse carries the whole tool input (a Write of a large file); still bounded.
				limit: HOOK_BODY_LIMIT,
				tooLarge: "payload_too_large",
				missing: "invalid_terminal_input",
				signal: c.req.raw.signal,
			});
			payload = JSON.parse(new TextDecoder().decode(bytes));
		} catch (error) {
			if (error instanceof Error && error.message === "payload_too_large") {
				service.hookTooLarge(id);
				return c.json({ error: "payload_too_large" }, 413);
			}
			return invalid(c);
		}
		const parsed = hookPayloadSchema.safeParse(payload);
		// Events this host does not use are accepted and ignored.
		if (!parsed.success) return c.body(null, 204);
		try {
			await service.hook(id, token, parsed.data);
		} catch (error) {
			if (error instanceof Error && error.message === "terminal_hook_forbidden")
				throw error;
			// A final state could not be saved: tell Claude Code's hook; it is tried once more.
			return c.json({ error: "terminal_hook_save_failed" }, 503);
		}
		return c.body(null, 204);
	});
	app.get("/api/terminals/:id/output", (c) => {
		const id = idOf(c);
		if (!id) return invalid(c);
		return service.stream(id, c.req.raw.signal);
	});
}
