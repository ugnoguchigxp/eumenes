import type { Hono } from "hono";
import { z } from "zod";
import type { createAgencyHost } from "./host";
import {
	agencyActivitySchema,
	type AgencyActivity,
} from "../../domains/dialogue/contracts/agency-status";

export function registerAgency(
	app: Hono,
	host: Pick<ReturnType<typeof createAgencyHost>, "status"> & {
		attend(
			id: string,
			activity?: AgencyActivity,
		): ReturnType<ReturnType<typeof createAgencyHost>["attend"]>;
	},
) {
	const id = z.string().min(1).max(160);
	app.get("/api/agency/conversations/:id/status", (c) => {
		const parsed = id.safeParse(c.req.param("id"));
		return parsed.success
			? c.json(host.status(parsed.data))
			: c.json({ error: "invalid_conversation_id" }, 400);
	});
	app.post("/api/agency/conversations/:id/attention", async (c) => {
		const parsed = id.safeParse(c.req.param("id"));
		if (!parsed.success)
			return c.json({ error: "invalid_conversation_id" }, 400);
		const body = await c.req.text();
		let activity: AgencyActivity | undefined;
		if (body) {
			let raw: unknown;
			try {
				raw = JSON.parse(body);
			} catch {
				return c.json({ error: "invalid_agency_activity" }, 400);
			}
			const value = agencyActivitySchema.safeParse(raw);
			if (!value.success)
				return c.json({ error: "invalid_agency_activity" }, 400);
			activity = value.data;
		}
		try {
			return c.json(await host.attend(parsed.data, activity));
		} catch (error) {
			if (error instanceof Error && error.message === "agency_unavailable")
				return c.json({ error: "agency_unavailable" }, 503);
			throw error;
		}
	});
}
