import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "./http";

const schema = z.object({ name: z.string(), reason: z.string().optional() });

function app(options?: Parameters<typeof parseJsonBody>[2]) {
	const hono = new Hono();
	hono.post("/", async (c) => {
		const parsed = await parseJsonBody(c, schema, options);
		if (!parsed.ok) return parsed.response;
		return c.json(parsed.data);
	});
	return hono;
}
const post = (hono: Hono, body?: string) =>
	hono.request("/", { method: "POST", body });

describe("parseJsonBody", () => {
	it("returns the validated data", async () => {
		const res = await post(app(), JSON.stringify({ name: "a" }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "a" });
	});
	it("answers 400 invalid_input for malformed JSON, a missing body and schema mismatch", async () => {
		for (const body of ["{", undefined, JSON.stringify({ name: 1 })]) {
			const res = await post(app(), body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_input" });
		}
	});
	it("uses the given error code", async () => {
		const res = await post(app({ code: "invalid_voice_ids" }), "nope");
		expect(await res.json()).toEqual({ error: "invalid_voice_ids" });
	});
	it("validates emptyAs for an empty body but still rejects malformed JSON", async () => {
		const lenient = z.object({ reason: z.string().optional() });
		const hono = new Hono();
		hono.post("/", async (c) => {
			const parsed = await parseJsonBody(c, lenient, { emptyAs: {} });
			return parsed.ok ? c.json(parsed.data) : parsed.response;
		});
		const empty = await post(hono, "");
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual({});
		expect((await post(hono, "{")).status).toBe(400);
	});
});
