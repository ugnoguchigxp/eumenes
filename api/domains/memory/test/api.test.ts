import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { configureLogging } from "../../../infrastructure/logger";
import { memoryItemsSchema } from "../contracts";
import { registerMemory } from "..";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const open: MemoryHarness[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	open.push(h);
	const app = new Hono();
	registerMemory(app, h.memory);
	app.onError((error, c) => c.json({ error: error.message }, 400));
	return { h, app };
}

test("items carry their evidence, period and who asked for them", async () => {
	const { h, app } = await setup();
	const id = await h.say("user", "9月からZedを使ってる", "c1", "run-a");
	await h.remember({
		conversationId: "c1",
		messageId: id,
		quote: "Zedを使ってる",
		kind: "habit",
		semanticKey: "editor",
		text: "Zedを使っている",
		validFrom: "2026-09",
	});
	const response = await app.request("/api/memory/items");
	const { items } = memoryItemsSchema.parse(await response.json());
	expect(items).toHaveLength(1);
	expect(items[0]).toMatchObject({
		evidence: [{ messageId: id, quote: "Zedを使ってる" }],
		validity: { from: "2026-09" },
		capturedBy: "request",
	});
	// An item with no period has none.
	await h.seed("コーヒーが好き", "drink.coffee");
	const second = memoryItemsSchema.parse(
		await (await app.request("/api/memory/items")).json(),
	).items;
	expect(
		second.find((i) => i.semanticKey === "drink.coffee")?.validity,
	).toBeNull();
});

test("plans of the named conversation only; closed plans are not listed", async () => {
	const { h } = await setup();
	const first = await h.plan("c1", { kind: "intent", text: "Rust移行" });
	await h.plan("c2", { kind: "plan", text: "別の会話", dueAt: "2026-11-30" });
	const items = h.memory.plans("c1");
	expect(items.map((i) => i.text)).toEqual(["Rust移行"]);
	expect(items[0]).toMatchObject({
		kind: "intent",
		state: "open",
		dueAt: null,
	});
	await h.closePlan(first.id, first.revision);
	expect(h.memory.plans("c1")).toEqual([]);
	expect(h.memory.plans("c2").map((i) => i.text)).toEqual(["別の会話"]);
});

test("tendencies are listed; there is no route to read, change or delete them by hand", async () => {
	const { h, app } = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("毎朝走る", "run", "毎朝走る", "habit");
	const [added] = await h.curate([
		{
			op: "tendency_add",
			text: "朝型",
			evidence: [
				{ namespace: "state", id: a.id },
				{ namespace: "state", id: b.id },
			],
		},
	]);
	expect(added).toMatchObject({ status: "applied", op: "tendency_add" });
	const listed = h.memory.tendencies();
	expect(listed).toMatchObject([{ text: "朝型", revision: 1 }]);
	for (const [method, path, body] of [
		["GET", "/api/memory/tendencies", undefined],
		["DELETE", `/api/memory/tendencies/${listed[0]!.id}`, undefined],
		["POST", "/api/memory/items", { nope: 1 }],
		["POST", `/api/memory/items/${a.id}/stop`, { expectedRevision: 1 }],
		["POST", `/api/memory/items/${a.id}/resume`, { expectedRevision: 1 }],
		["POST", `/api/memory/items/${a.id}/retract`, { expectedRevision: 1 }],
		["POST", `/api/memory/items/${a.id}/forget`, {}],
	] as const) {
		const response = await app.request(path, {
			method,
			...(body
				? {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}
				: {}),
		});
		expect(response.status).toBe(404);
	}
	expect(h.memory.tendencies()).toHaveLength(1);
});

test("while the journal is inconsistent none of the reads shows a body", async () => {
	const { h } = await setup();
	await h.seed("コーヒーが好き", "drink.coffee");
	await h.plan("c1", { kind: "intent", text: "Rust移行" });
	writeFileSync(join(h.dir, "journal.jsonl"), "not json\n");
	expect((await h.memory.recover()).healthy).toBe(false);
	expect(h.memory.plans("c1")).toEqual([]);
	expect(h.memory.tendencies()).toEqual([]);
});

test("a plan does not change the long-term window", async () => {
	const { h } = await setup();
	const first = await h.window();
	await h.plan("c1", {
		kind: "plan",
		text: "水曜に歯医者",
		dueAt: "2026-10-14",
	});
	await h.plan("c1", { kind: "intent", text: "Rust移行" });
	expect((await h.window()).version).toBe(first.version);
	h.time.now = "2026-10-21T12:00:00.000Z";
	const later = await h.window();
	expect(later.version).toBe(first.version);
	expect(later.profile.items).toEqual(first.profile.items);
});
