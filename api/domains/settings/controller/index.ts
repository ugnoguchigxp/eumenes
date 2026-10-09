import { readBounded } from "../../../infrastructure/bounded-read";
import type { Hono } from "hono";
import { applySchema } from "../contracts";
import type { SettingsService } from "../service";
export function registerSettings(app: Hono, settings: SettingsService) {
	app.get("/api/settings", (c) => c.json(settings.get()));
	app.get("/api/settings/diagnostics", (c) => c.json(settings.diagnostics()));
	app.post("/api/settings/apply", async (c) => {
		let bytes: Uint8Array;
		try {
			bytes = await readBounded(c.req.raw.body, {
				limit: 65536,
				tooLarge: "invalid_body_size",
				missing: "invalid_body",
			});
		} catch (error) {
			const code = error instanceof Error ? error.message : "";
			if (code === "invalid_body_size") return c.json({ error: code }, 413);
			if (code === "invalid_body") return c.json({ error: code }, 400);
			throw error;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}
		const parsed = applySchema.safeParse(raw);
		if (!parsed.success)
			return c.json(
				{ error: "invalid_settings", issues: parsed.error.issues },
				400,
			);
		return c.json(await settings.apply(parsed.data));
	});
}
