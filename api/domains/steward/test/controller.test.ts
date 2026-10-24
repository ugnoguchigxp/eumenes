import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSteward } from "..";
import { setupSteward, type StewardHarness } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});

test("the decisions and the event log are read over HTTP", async () => {
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
	const { inputMessageId } = await h.run({ user: "やあ", end: "completed" });
	await h.drain();

	const decisions = await app.request(
		"/api/steward/decisions?conversationId=c1&limit=2",
	);
	expect(decisions.status).toBe(200);
	const body = (await decisions.json()) as { items: Array<{ step: string }> };
	expect(body.items.map((d) => d.step)).toEqual([
		"prepare-recall",
		"curate-memory",
	]);

	const events = await app.request("/api/steward/events?conversationId=c1");
	const log = (await events.json()) as {
		items: Array<{
			type: string;
			by: string;
			messageIds: string[];
			curated: boolean;
		}>;
	};
	expect(log.items).toMatchObject([
		{ type: "said", by: "user", messageIds: [inputMessageId], curated: true },
		{ type: "said", by: "agent", curated: true },
	]);

	expect((await app.request("/api/steward/decisions")).status).toBe(400);
	expect(
		(await app.request("/api/steward/decisions?conversationId=c1&limit=0"))
			.status,
	).toBe(400);
	expect((await app.request("/api/steward/events")).status).toBe(400);
});
