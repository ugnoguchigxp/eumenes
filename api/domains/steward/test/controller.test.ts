import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSteward } from "..";
import { setupSteward, type StewardHarness } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});

test("the decisions are read over HTTP", async () => {
	const h = await setupSteward();
	harnesses.push(h);
	const app = new Hono();
	registerSteward(app, h.steward);
	app.onError((error, c) => c.json({ error: error.message }, 400));
	h.inference.script("curate-memory", {
		remember: [],
		update: [],
		stop: [],
		notes: [],
		resolve: [],
	});
	await h.run({ user: "やあ", end: "completed" });
	await h.drain();

	const decisions = await app.request(
		"/api/steward/decisions?conversationId=c1&limit=2",
	);
	expect(decisions.status).toBe(200);
	const body = (await decisions.json()) as { items: Array<{ step: string }> };
	expect(body.items.map((d) => d.step)).toEqual(["curate-memory"]);

	expect((await app.request("/api/steward/decisions")).status).toBe(400);
	expect(
		(await app.request("/api/steward/decisions?conversationId=c1&limit=0"))
			.status,
	).toBe(400);
});
