import { z } from "zod";
import type { Hono } from "hono";
import { screenPresenceSchema } from "../contracts/screen-presence";
import type { InferenceService } from "../service";

export function registerScreenPresence(
	app: Hono,
	service: Pick<InferenceService, "screenPresence">,
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
		service.screenPresence(
			c.req.param("id"),
			input.data.revision,
			input.data.active,
			input.data.sentAt,
		);
		return c.body(null, 204);
	});
}
