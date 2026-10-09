import type { Hono } from "hono";
import type { ServiceTests } from "../service";
import { startSchema } from "../contracts";
async function bounded(request: Request, limit: number) {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("invalid_body");
	const chunks: Uint8Array[] = [];
	let n = 0;
	try {
		for (;;) {
			const c = await reader.read();
			if (c.done) break;
			n += c.value.length;
			if (n > limit) throw new Error("invalid_body_size");
			chunks.push(c.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const result = new Uint8Array(n);
	let at = 0;
	for (const b of chunks) {
		result.set(b, at);
		at += b.length;
	}
	return result;
}
export function registerServiceTests(app: Hono, s: ServiceTests) {
	app.get("/api/service-tests/catalog", (c) => c.json(s.catalog()));
	app.post("/api/service-tests/catalog/refresh", async (c) =>
		c.json(await s.refresh()),
	);
	app.get("/api/service-tests/runs", (c) => c.json(s.runs()));
	app.post("/api/service-tests/diagnose", async (c) =>
		c.json(await s.diagnose(), 202),
	);
	app.post("/api/service-tests/uploads", async (c) =>
		c.json(s.upload(await bounded(c.req.raw, 4_000_000)), 201),
	);
	app.post("/api/service-tests/runs", async (c) => {
		let body: unknown;
		try {
			body = JSON.parse(
				new TextDecoder().decode(await bounded(c.req.raw, 40_000)),
			);
		} catch {
			return c.json({ error: "invalid_body" }, 400);
		}
		const input = startSchema.safeParse(body);
		if (!input.success) return c.json({ error: "invalid_test_input" }, 400);
		return c.json(await s.start(input.data), 202);
	});
	app.get("/api/service-tests/runs/:id", (c) => {
		const r = s.run(c.req.param("id"));
		return r ? c.json(r) : c.json({ error: "not_found" }, 404);
	});
	app.post("/api/service-tests/runs/:id/cancel", async (c) => {
		await s.cancel(c.req.param("id"));
		return c.json({ ok: true });
	});
	app.post("/api/service-tests/runs/:id/retry-artifact", async (c) =>
		c.json(await s.retryArtifact(c.req.param("id")), 202),
	);
	app.get("/api/service-tests/runs/:id/artifact", (c) => {
		const p = s.preview(c.req.param("id"));
		if (!p?.bytes || !p.mime) return c.json({ error: "preview_expired" }, 410);
		return new Response(new Uint8Array(p.bytes), {
			headers: {
				"Content-Type": p.mime,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});
}
