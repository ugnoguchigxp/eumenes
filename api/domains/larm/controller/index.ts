import type { Hono } from "hono";
import type { LarmPort } from "../contracts";
export function registerLarmStatus(
	app: Hono,
	service: Pick<LarmPort, "status" | "connect">,
) {
	app.get("/api/status", (c) =>
		c.json({ service: "eumenes", larm: service.status() }),
	);
	app.post("/api/larm/connect", async (c) => {
		await service.connect().catch(() => {});
		return c.json({ service: "eumenes", larm: service.status() });
	});
}
