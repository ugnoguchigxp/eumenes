import type { Hono } from "hono";
import { parseJsonBody } from "../../../infrastructure/http";
import type { MemoryService } from "..";
import { settingsSchema } from "../contracts";
import { memorySeedInputSchema } from "../contracts/seeds";
export function registerMemory(app: Hono, service: MemoryService) {
	app.post("/api/memory/seeds/preview", async (c) => {
		const parsed = await parseJsonBody(c, memorySeedInputSchema, {
			code: "invalid_memory_seed",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(service.previewSeeds(parsed.data));
	});
	app.post("/api/memory/seeds/import", async (c) => {
		const parsed = await parseJsonBody(c, memorySeedInputSchema, {
			code: "invalid_memory_seed",
		});
		if (!parsed.ok) return parsed.response;
		return c.json(await service.importSeeds(parsed.data));
	});
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
}
