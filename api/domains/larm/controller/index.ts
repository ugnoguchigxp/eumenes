import type { Hono } from "hono";
import { ignoreError } from "../../../infrastructure/ignore-error";
import { getLogger } from "../../../infrastructure/logger";
import type { LarmPort } from "../contracts";

const log = getLogger("larm");
export function registerLarmStatus(
	app: Hono,
	service: Pick<LarmPort, "status" | "connect">,
) {
	app.get("/api/status", (c) =>
		c.json({ service: "eumenes", larm: service.status() }),
	);
	app.post("/api/larm/connect", async (c) => {
		// The response reports the resulting status; the failure itself is only traced.
		await service
			.connect()
			.catch(ignoreError(log, "larm.connect_ignored", "connect_failed"));
		return c.json({ service: "eumenes", larm: service.status() });
	});
}
