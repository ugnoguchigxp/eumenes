import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseJsonBody } from "../../../infrastructure/http";
import type { MemoryService } from "..";
import { settingsSchema } from "../contracts";
import { memorySeedInputSchema } from "../contracts/seeds";
import { memoryMaintenanceInput } from "../service/maintenance";
export function registerMemory(app: Hono, service: MemoryService) {
	app.use(
		"/api/memory/maintenance/*",
		bodyLimit({
			maxSize: 131072,
			onError: (c) => c.json({ error: "payload_too_large" }, 413),
		}),
	);
	app.get("/api/memory/maintenance", (c) =>
		c.json(service.maintenance.list(c.req.query("conversationId") ?? "main")),
	);
	for (const action of ["preview", "apply"] as const)
		app.post(`/api/memory/maintenance/${action}`, async (c) => {
			const parsed = await parseJsonBody(c, memoryMaintenanceInput, {
				code: "invalid_maintenance_input",
			});
			if (!parsed.ok) return parsed.response;
			try {
				return c.json(await service.maintenance[action](parsed.data));
			} catch (error) {
				if (
					error instanceof Error &&
					["maintenance_conflict", "memory_unavailable"].includes(error.message)
				)
					return c.json({ error: error.message }, 409);
				throw error;
			}
		});
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
