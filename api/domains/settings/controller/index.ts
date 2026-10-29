import { readBounded } from "../../../infrastructure/bounded-read";
import type { Hono } from "hono";
import { applySchema } from "../contracts";
import type { SettingsService } from "../service";
export function registerSettings(app: Hono, settings: SettingsService) {
	app.get("/api/settings/browser-bridge", (c) =>
		c.json(settings.browserBridge(), 200, { "Cache-Control": "no-store" }),
	);
	app.put("/api/settings/browser-bridge", async (c) => {
		const raw = await readBounded(c.req.raw.body, {
			limit: 8192,
			tooLarge: "invalid_body_size",
			missing: "invalid_body",
		});
		let input: unknown;
		try {
			input = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			throw new Error("invalid_browser_bridge");
		}
		try {
			return c.json(await settings.configureBrowserBridge(input), 200, {
				"Cache-Control": "no-store",
			});
		} catch (error) {
			if (error instanceof Error && error.message === "conflict_browser_bridge")
				return c.json({ error: "conflict_browser_bridge" }, 409, {
					"Cache-Control": "no-store",
				});
			throw error;
		}
	});
	app.get("/api/settings/docling", (c) =>
		c.json(settings.doclingConnection(), 200, { "Cache-Control": "no-store" }),
	);
	app.put("/api/settings/docling", async (c) => {
		const raw = await readBounded(c.req.raw.body, {
			limit: 8192,
			tooLarge: "invalid_body_size",
			missing: "invalid_body",
		});
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			throw new Error("invalid_docling_settings");
		}
		return c.json(await settings.configureDocling(value));
	});
	app.get("/api/settings/excalidraw", (c) =>
		c.json(settings.excalidrawConnection()),
	);
	app.put("/api/settings/excalidraw", async (c) => {
		const raw = await readBounded(c.req.raw.body, {
			limit: 16384,
			tooLarge: "invalid_body_size",
			missing: "invalid_body",
		});
		return c.json(
			await settings.configureExcalidraw(
				JSON.parse(new TextDecoder().decode(raw)),
			),
		);
	});
	app.get("/api/settings/ocr", (c) => c.json(settings.ocrConnection()));
	app.put("/api/settings/ocr", async (c) => {
		const raw = await readBounded(c.req.raw.body, {
			limit: 16384,
			tooLarge: "invalid_body_size",
			missing: "invalid_body",
		});
		return c.json(
			await settings.configureOcr(JSON.parse(new TextDecoder().decode(raw))),
		);
	});
	app.get("/api/settings/object-recognition", (c) =>
		c.json(settings.objectRecognitionConnection()),
	);
	app.put("/api/settings/object-recognition", async (c) => {
		const raw = await readBounded(c.req.raw.body, {
			limit: 16384,
			tooLarge: "invalid_body_size",
			missing: "invalid_body",
		});
		return c.json(
			await settings.configureObjectRecognition(
				JSON.parse(new TextDecoder().decode(raw)),
			),
		);
	});
	app.get("/api/settings", (c) => c.json(settings.get()));
	app.get("/api/settings/intent", (c) =>
		c.json(settings.get().intent, 200, { "Cache-Control": "no-store" }),
	);
	app.put("/api/settings/intent", async (c) => {
		const raw = await readBounded(c.req.raw.body, {
			limit: 4096,
			tooLarge: "invalid_body_size",
			missing: "invalid_body",
		});
		let input: unknown;
		try {
			input = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			throw new Error("invalid_intent_settings");
		}
		return c.json(await settings.configureIntent(input), 200, {
			"Cache-Control": "no-store",
		});
	});
	app.get("/api/settings/diagnostics", (c) => c.json(settings.diagnostics()));
	app.post("/api/settings/apply", async (c) => {
		const bytes = await readBounded(c.req.raw.body, {
			limit: 65536,
			tooLarge: "invalid_body_size",
			missing: "invalid_body",
		});
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
