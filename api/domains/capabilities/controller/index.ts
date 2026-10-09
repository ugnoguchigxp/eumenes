import type { Hono } from "hono";
import type { Capabilities } from "../service";
export function registerCapabilities(app: Hono, service: Capabilities) {
	app.get("/api/capabilities", (c) => {
		const raw = c.req.query("limit") ?? "50";
		if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50)
			throw new Error("invalid_capability_limit");
		return c.json(service.list(c.req.query("cursor") ?? "", Number(raw)));
	});
}
