import type { Hono } from "hono";
import { applySchema } from "../contracts";
import type { SettingsService } from "../service";
export function registerSettings(app: Hono, settings: SettingsService) {
	app.get("/api/settings", (c) => c.json(settings.get()));
	app.get("/api/settings/diagnostics", (c) => c.json(settings.diagnostics()));
	app.post("/api/settings/apply", async (c) => {
		const reader = c.req.raw.body?.getReader();
		if (!reader) return c.json({ error: "invalid_body" }, 400);
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 65536) {
				await reader.cancel();
				return c.json({ error: "invalid_body_size" }, 413);
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
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
