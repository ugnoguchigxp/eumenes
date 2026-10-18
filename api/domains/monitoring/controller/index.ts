import type { Hono } from "hono";
import type { MonitoringService } from "../service";

export function registerMonitoring(app: Hono, m: MonitoringService) {
	app.get("/api/monitoring/snapshot", async (c) => c.json(await m.snapshot()));
}
