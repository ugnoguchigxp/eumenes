import { z } from "zod";
import type { Hono } from "hono";
import { screenPresenceSchema } from "../contracts/screen-presence";
import type { InferenceService } from "../service";

export function registerScreenPresence(
	app: Hono,
	service: Pick<InferenceService, "screenPresence" | "isPlaybackScreen">,
) {
	app.put("/api/inference/screen/:id", async (c) => {
		if (!z.uuid().safeParse(c.req.param("id")).success)
			return c.json({ error: "invalid_request" }, 400);
		const text = await c.req.text();
		if (text.length > 256) return c.json({ error: "invalid_request" }, 413);
		const input = screenPresenceSchema.safeParse(
			await Promise.resolve()
				.then(() => JSON.parse(text))
				.catch(() => null),
		);
		if (!input.success) return c.json({ error: "invalid_request" }, 400);
		const { revision, active, sentAt, ...details } = input.data;
		return c.json({
			playbackScreen: service.screenPresence(
				c.req.param("id"),
				revision,
				active,
				sentAt,
				details,
			),
		});
	});
	/** Whether this screen is the one that plays sound; asked again on every change notice. */
	app.get("/api/inference/screen/:id", (c) => {
		if (!z.uuid().safeParse(c.req.param("id")).success)
			return c.json({ error: "invalid_request" }, 400);
		return c.json({
			playbackScreen: service.isPlaybackScreen(c.req.param("id")),
		});
	});
}
