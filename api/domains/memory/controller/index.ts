import type { Hono } from "hono";
import { parseJsonBody } from "../../../infrastructure/http";
import type { MemoryService } from "..";
import {
	conversationQuerySchema,
	itemActionSchema,
	rememberSchema,
	settingsSchema,
} from "../contracts";
export function registerMemory(app: Hono, service: MemoryService) {
	app.get("/api/memory/status", (c) => c.json(service.status()));
	app.post("/api/memory/settings", async (c) => {
		const parsed = await parseJsonBody(c, settingsSchema, {
			code: "invalid_memory_settings",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(await service.setEnabled(parsed.data.enabled));
	});
	app.get("/api/memory/items", (c) =>
		c.json({ items: service.list(c.req.query("all") === "1") }),
	);
	app.post("/api/memory/items", async (c) => {
		const parsed = await parseJsonBody(c, rememberSchema, {
			code: "invalid_memory_input",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(await service.remember(parsed.data), 201);
	});
	for (const action of ["stop", "resume", "retract"] as const)
		app.post(`/api/memory/items/:id/${action}`, async (c) => {
			const parsed = await parseJsonBody(c, itemActionSchema, {
				code: "invalid_memory_input",
			});
			if (!parsed.ok) return parsed.response;
			return c.json(
				await service[action](c.req.param("id"), parsed.data.expectedRevision),
			);
		});
	app.post("/api/memory/items/:id/forget", async (c) =>
		c.json(await service.forget(c.req.param("id"))),
	);
	// There is no default conversation: the caller names the one it shows.
	const conversationOf = (query: string | undefined): string => {
		const parsed = conversationQuerySchema.safeParse({ conversationId: query });
		if (!parsed.success) throw new Error("invalid_memory_input");
		return parsed.data.conversationId;
	};
	app.get("/api/memory/short-term", (c) =>
		c.json({
			items: service.shortTerm(conversationOf(c.req.query("conversationId"))),
		}),
	);
	app.get("/api/memory/tendencies", (c) =>
		c.json({ items: service.tendencies() }),
	);
	app.delete("/api/memory/tendencies/:id", async (c) =>
		c.json(await service.deleteTendency(c.req.param("id"))),
	);
	app.get("/api/memory/context", async (c) =>
		c.json(
			await service.context(conversationOf(c.req.query("conversationId"))),
		),
	);
}
