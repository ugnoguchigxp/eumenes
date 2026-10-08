import type { Hono } from "hono";
import { deleteSchema, saveSchema } from "../contracts";
import type { TtsDictionaryService } from "../service";
async function body(c: { req: { text(): Promise<string> } }) {
	const text = await c.req.text();
	if (text.length > 4096) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}
export function registerTtsDictionary(
	app: Hono,
	service: TtsDictionaryService,
) {
	app.get("/api/tts-dictionary", (c) => c.json({ entries: service.list() }));
	app.post("/api/tts-dictionary/save", async (c) => {
		const parsed = saveSchema.safeParse(await body(c));
		if (!parsed.success) return c.json({ error: "invalid_entry" }, 400);
		return c.json({ entries: await service.save(parsed.data) });
	});
	app.post("/api/tts-dictionary/delete", async (c) => {
		const parsed = deleteSchema.safeParse(await body(c));
		if (!parsed.success) return c.json({ error: "invalid_entry" }, 400);
		return c.json({ entries: await service.delete(parsed.data) });
	});
}
