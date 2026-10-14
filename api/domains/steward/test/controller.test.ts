import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSteward } from "..";
import { keepAll, setupSteward, type StewardHarness } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});

test("the decisions and the exchange ledger are read over HTTP", async () => {
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
	h.inference.script("dispose-exchanges", keepAll);
	const { inputMessageId } = await h.run({ user: "やあ", end: "completed" });
	await h.drain();

	const decisions = await app.request(
		"/api/steward/decisions?conversationId=c1&limit=2",
	);
	expect(decisions.status).toBe(200);
	const body = (await decisions.json()) as { items: Array<{ step: string }> };
	expect(body.items.map((d) => d.step)).toEqual([
		"prepare-recall",
		"dispose-exchanges",
	]);

	const exchanges = await app.request(
		"/api/steward/exchanges?conversationId=c1",
	);
	const ledger = (await exchanges.json()) as {
		items: Array<{ inputMessageId: string; state: string }>;
	};
	expect(ledger.items).toMatchObject([{ inputMessageId, state: "done" }]);

	expect((await app.request("/api/steward/decisions")).status).toBe(400);
	expect(
		(await app.request("/api/steward/decisions?conversationId=c1&limit=0"))
			.status,
	).toBe(400);
	expect((await app.request("/api/steward/exchanges")).status).toBe(400);
});
