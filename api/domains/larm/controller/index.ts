import type { Hono } from "hono";
import type { LarmPort } from "../contracts";
export function registerLarmStatus(app: Hono, service: LarmPort) {
	app.get("/api/status", (c) =>
		c.json({ service: "eumenes", larm: service.status() }),
	);
}
