import type { Hono } from "hono";
import type { MemoryService } from "..";
import { itemActionSchema, rememberSchema, settingsSchema } from "../contracts";
export function registerMemory(app: Hono, service: MemoryService) {
	app.get("/api/memory/status", (c) => c.json(service.status()));
	app.post("/api/memory/settings", async (c) => {
		const parsed = settingsSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success)
			return c.json({ error: "invalid_memory_settings" }, 400);
		return c.json(await service.setEnabled(parsed.data.enabled));
	});
	app.get("/api/memory/items", (c) =>
		c.json({ items: service.list(c.req.query("all") === "1") }),
	);
	app.post("/api/memory/items", async (c) => {
		const parsed = rememberSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success) return c.json({ error: "invalid_memory_input" }, 400);
		return c.json(await service.remember(parsed.data), 201);
	});
	for (const action of ["stop", "resume", "retract"] as const)
		app.post(`/api/memory/items/:id/${action}`, async (c) => {
			const parsed = itemActionSchema.safeParse(
				await c.req.json().catch(() => null),
			);
			if (!parsed.success)
				return c.json({ error: "invalid_memory_input" }, 400);
			return c.json(
				await service[action](c.req.param("id"), parsed.data.expectedRevision),
			);
		});
	app.post("/api/memory/items/:id/forget", async (c) =>
		c.json(await service.forget(c.req.param("id"))),
	);
}
