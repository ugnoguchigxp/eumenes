import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { parseJsonBody } from "../../../infrastructure/http";
import { requirementProfileData } from "../contracts";
import type { Hono } from "hono";
import type { Capabilities } from "../service";
export function registerCapabilities(app: Hono, service: Capabilities) {
	app.use(
		"/api/capabilities/requirements/*",
		bodyLimit({
			maxSize: 32768,
			onError: (c) => c.json({ error: "payload_too_large" }, 413),
		}),
	);
	app.get("/api/capabilities/requirements", (c) => {
		const limit = c.req.query("limit") ?? "50";
		if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50)
			throw new Error("invalid_capability_limit");
		return c.json(
			service.listRequirementProfiles(
				c.req.query("cursor") ?? "",
				Number(limit),
			),
		);
	});
	app.get("/api/capabilities/requirements/:id", (c) => {
		const p = service.getRequirementProfile(c.req.param("id"));
		if (!p) throw new Error("requirement_not_found");
		return c.json(p);
	});
	app.put("/api/capabilities/requirements/:id", async (c) => {
		const b = await parseJsonBody(
			c,
			z
				.object({
					expectedStateToken: z.string().nullable(),
					data: requirementProfileData,
				})
				.strict(),
			{ code: "invalid_requirement_profile" },
		);
		if (!b.ok) return b.response;
		const p = await service.putRequirementProfile(
			c.req.param("id"),
			b.data.expectedStateToken,
			b.data.data,
		);
		return c.json(p, b.data.expectedStateToken === null ? 201 : 200);
	});
	app.post("/api/capabilities/requirements/:id/state", async (c) => {
		const b = await parseJsonBody(
			c,
			z
				.object({ expectedStateToken: z.string(), enabled: z.boolean() })
				.strict(),
			{ code: "invalid_requirement_profile" },
		);
		if (!b.ok) return b.response;
		return c.json(
			await service.setRequirementProfileState(
				c.req.param("id"),
				b.data.expectedStateToken,
				b.data.enabled,
			),
		);
	});
	app.get("/api/capabilities", (c) => {
		const raw = c.req.query("limit") ?? "50";
		if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50)
			throw new Error("invalid_capability_limit");
		return c.json(service.list(c.req.query("cursor") ?? "", Number(raw)));
	});
}
