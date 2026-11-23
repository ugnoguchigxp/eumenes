import { afterEach, expect, test } from "bun:test";
import {
	type StewardHarness,
	setupSteward,
	topicEmbed,
} from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup(options: Parameters<typeof setupSteward>[0] = {}) {
	const h = await setupSteward(options);
	harnesses.push(h);
	return h;
}
const empty = { remember: [], update: [], resolve: [] };
const remember = (over: Record<string, unknown> = {}) => ({
	kind: "preference",
	key: "food.spicy",
	text: "辛い食べ物が好き",
	evidence: "e1",
	quote: null,
	validFrom: null,
	validUntil: null,
	negated: false,
	...over,
});
/** Whether each event was handled by the reflection (the notices it wrote itself aside). */
const curated = (h: StewardHarness) =>
	h
		.log()
		.filter((e) => !e.text?.includes('"action":"memory.notice"'))
		.map((e) => e.curated);

test("the events of a run go through curate-memory: a memory is saved with the user's own words as its quote, and the events are handled", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [remember({ quote: "辛いものが好きです" })],
	});
	const { inputMessageId } = await h.exchange(
		"辛いものが好きです",
		"そうなんですね",
	);
	await h.drain();
	expect(curated(h)).toEqual([true, true]);
	expect(h.memory.list()).toMatchObject([
		{
			text: "辛い食べ物が好き",
			origin: "agent_inferred",
			capturedBy: "agent",
			evidence: [{ messageId: inputMessageId, quote: "辛いものが好きです" }],
		},
	]);
	expect(h.units().map((unit) => [unit.step, unit.state])).toEqual([
		["curate-memory", "applied"],
	]);
	const decisions = h.steward.decisions("c1");
	expect(decisions.map((d) => d.step)).toEqual(["curate-memory"]);
	expect(decisions.every((d) => d.windowVersionAfter !== null)).toBe(true);
	expect(h.inference.statuses("pending")).toBe(0);
	// The model read the user's and the agent's words as events, by who said them.
	const view = h.inference.callsOf("curate-memory")[0]!.data.events as Array<
		Record<string, unknown>
	>;
	expect(view).toMatchObject([
		{ id: "e1", by: "user", text: "辛いものが好きです" },
		{ id: "e2", by: "agent", origin: "reply", text: "そうなんですね" },
	]);
	// Nothing is left to do: a kick makes no unit.
	await h.kick();
	expect(h.units()).toHaveLength(1);
});

test("a later event updates the memory, and the negation the model gives is kept both ways", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [
			remember({
				key: "food.test",
				text: "辛いものが好き",
				quote: "辛いものが好きではありません",
				negated: true,
			}),
		],
	});
	await h.exchange("辛いものが好きではありません", "了解しました");
	await h.drain();
	expect(h.memory.list()[0]).toMatchObject({ polarity: "negated" });
	for (const negated of [false, true]) {
		const said = negated ? "今も香辛料が好きではない" : "今は香辛料が好き";
		h.inference.script("curate-memory", (data) => {
			const entry = (data.longTerm as Array<Record<string, unknown>>)[0]!;
			expect(entry).toMatchObject({
				key: "food.test",
				origin: "agent_inferred",
			});
			return {
				...empty,
				update: [
					{
						ref: entry.ref,
						text: "香辛料が好き",
						evidence: "e1",
						quote: said,
						negated,
					},
				],
			};
		});
		await h.exchange(said, "了解しました");
		await h.drain();
		expect(h.memory.list()[0]).toMatchObject({
			text: "香辛料が好き",
			polarity: negated ? "negated" : "affirmed",
		});
	}
});

test("the user's utterance that made a request is shown as context only: nothing is saved from it, the request is answered", async () => {
	const h = await setup();
	h.inference.script("curate-memory", (data) => {
		// The utterance is the request's context, not an event to learn from. The agent's answer waits for the user's
		// next words (only the user's words ground a record), so it is not read yet.
		expect(data.events as unknown[]).toMatchObject([
			{ id: "x1", by: "user", reference: true },
		]);
		expect(data.events as unknown[]).toHaveLength(1);
		return {
			...empty,
			remember: [remember({ key: "food.salty", text: "しょっぱいものが好き" })],
			resolve: [
				{
					request: "r1",
					action: "remember",
					refs: [],
					alsoIn: [],
					text: "辛い食べ物が好き",
					kind: "preference",
					key: "food.spicy",
					negated: null,
				},
			],
		};
	});
	await h.run({
		user: "辛いものが好きです。覚えておいて",
		answer: "覚えておきます",
		end: "completed",
		requests: [{ kind: "remember", what: "辛いものが好き" }],
	});
	await h.drain();
	expect(h.memory.list().map((item) => item.semanticKey)).toEqual([
		"food.spicy",
	]);
	const results = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-memory")!.results as Array<{
		section?: string;
		status: string;
		code?: string;
		reason?: string;
	}>;
	expect(
		results.map((r) => [r.section, r.status, r.reason ?? r.code ?? null]),
	).toContainEqual(["remember", "rejected", "unknown_evidence"]);
	expect(curated(h)).toContain(true);
	expect(h.inbox()).toContainEqual(
		expect.objectContaining({ kind: "remember", state: "done" }),
	);
});

test("events that carry nothing to learn from are handled without a model", async () => {
	const h = await setup();
	await h.store.write((db) => {
		for (const [type, by] of [
			["delivered", "host"],
			["acted", "agent"],
			["notice", "host"],
			["said", "specialist"],
		] as const)
			h.continuity.events.appendInTransaction(db, {
				conversationId: "c1",
				at: new Date(h.time.ms).toISOString(),
				type,
				by,
				fields: { text: "x" },
			});
		h.continuity.events.appendInTransaction(db, {
			conversationId: "c1",
			at: new Date(h.time.ms).toISOString(),
			type: "said",
			by: "user",
			fields: { text: "定期の問い合わせ" },
			messageIds: ["blocked-1"],
		});
	});
	await h.conversation.append({
		id: "blocked-1",
		conversationId: "c1",
		role: "user",
		text: "定期の問い合わせ",
		createdAt: new Date(h.time.ms).toISOString(),
		runId: null,
	});
	await h.store.write((db) => {
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: ["blocked-1"],
			reason: "scheduled_prompt",
		});
		h.steward.kickInTransaction(db, "c1");
	});
	await h.drain();
	expect(curated(h)).toEqual([true, true, true, true, true]);
	expect(h.inference.callsOf("curate-memory")).toHaveLength(0);
	expect(h.units()).toEqual([]);
});

test("a failed answer is run again without saving the memory twice", async () => {
	const h = await setup();
	h.inference.script("curate-memory", new Error("unusable_answer"), {
		...empty,
		remember: [remember()],
	});
	await h.exchange("辛いものが好きです", "了解");
	await h.drain();
	expect(h.inference.callsOf("curate-memory")).toHaveLength(2);
	expect(h.memory.list()).toHaveLength(1);
	expect(curated(h)).toEqual([true, true]);
	const states = h.units().map((unit) => `${unit.step}:${unit.state}`);
	expect(states).toContain("curate-memory:failed");
	expect(states).toContain("curate-memory:applied");
});

test("three unusable answers over events give them up and the pipeline goes on", async () => {
	const h = await setup();
	h.inference.script("curate-memory", "not json", "{]", "[]");
	await h.exchange("こんにちは", "こんにちは");
	await h.drain();
	expect(curated(h)).toEqual([true, true]);
	expect(h.memory.list()).toEqual([]);
	expect(
		h
			.units()
			.filter((u) => u.step === "curate-memory")
			.map((u) => u.state),
	).toEqual(["failed", "failed", "failed"]);
	// The count is not kept once they are given up.
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM steward_event_failure").get() as {
						n: number;
					}
				).n,
		),
	).toBe(0);
});

test("an event that is already handled is not offered again", async () => {
	const h = await setup();
	h.inference.script("curate-memory", { ...empty, remember: [remember()] });
	const run = await h.exchange("辛いものが好きです", "了解");
	await h.drain();
	const before = h.memory.list(true);
	// A request unit over the same message: its events carry the mark already.
	await h.store.write((db) =>
		h.steward.requestInTransaction(db, {
			requestId: "r-x",
			conversationId: "c1",
			sourceRef: run.inputMessageId,
			kind: "remember",
			what: "x",
		}),
	);
	await h.runEnded("run-x", "c1", "cancelled");
	h.inference.script("curate-memory", (data) => {
		// The message is shown as context for the request only.
		expect(data.events as unknown[]).toMatchObject([
			{ id: "x1", reference: true },
		]);
		return {
			...empty,
			resolve: [
				{
					request: "r1",
					action: "none",
					refs: [],
					alsoIn: [],
					text: null,
					kind: null,
					key: null,
				},
			],
		};
	});
	await h.drain();
	expect(h.inference.callsOf("curate-memory")).toHaveLength(2);
	expect(h.memory.list(true)).toEqual(before);
	expect(curated(h)).toEqual([true, true]);
});

test("elements that cannot be saved are dropped one by one", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [
			remember({ key: "BAD KEY!!" }),
			remember({ key: "food.salty", text: "しょっぱいものが好き" }),
			remember({ key: "food.sweet", text: "甘いもの", evidence: "e9" }),
		],
	});
	await h.exchange("しょっぱいものが好き", "了解");
	await h.drain();
	expect(h.memory.list().map((i) => i.semanticKey)).toEqual(["food.salty"]);
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-memory")!;
	const results = decision.results as Array<{ status: string; code?: string }>;
	expect(results.map((r) => r.code ?? r.status)).toEqual([
		"invalid_key",
		"applied",
		"unknown_evidence",
	]);
});

test("a mismatched quote and the agent's words cannot become evidence of a saved memory", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [
			remember({ quote: "辛いもの" }),
			remember({
				key: "food.salty",
				text: "しょっぱい",
				quote: "書いていない言葉",
			}),
			remember({ key: "food.sweet", text: "甘いもの", evidence: "e2" }),
		],
	});
	const { inputMessageId } = await h.exchange("辛いものが好きです", "なるほど");
	await h.drain();
	const items = h.memory.list();
	expect(items).toHaveLength(1);
	expect(items.every((i) => i.sourceMessageIds.join() === inputMessageId)).toBe(
		true,
	);
	const results = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-memory")!.results as Array<{
		quoteMatched?: boolean;
		code?: string;
	}>;
	expect(results.map((r) => r.quoteMatched ?? r.code)).toEqual([
		true,
		"invalid_source",
		"unknown_evidence",
	]);
});

test("a failed attempt reaches curate-memory as the user's event alone", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty);
	await h.exchange("予算は3万円以内で", null);
	await h.drain();
	const view = h.inference.callsOf("curate-memory")[0]!.data.events as Array<
		Record<string, unknown>
	>;
	expect(view).toMatchObject([{ id: "e1", by: "user" }]);
	expect(curated(h)).toEqual([true]);
});

test("long messages are cut to 6 KB for the steward, and one event always fits", async () => {
	const h = await setup();
	const long = "あ".repeat(4000);
	h.inference.script("curate-memory", empty);
	await h.exchange(`先頭${long}末尾`, `${long}答え`);
	await h.drain();
	const events = h.inference.callsOf("curate-memory")[0]!.data.events as Array<
		Record<string, any>
	>;
	const user = events[0]!;
	expect(user.truncated).toBe(true);
	expect(events[1]!.truncated).toBe(true);
	expect(user.text).toContain("（中略）");
	expect(user.text.startsWith("先頭")).toBe(true);
	expect(user.text.endsWith("末尾")).toBe(true);
	expect(new TextEncoder().encode(user.text).length).toBeLessThanOrEqual(
		6 * 1024 + 32,
	);
	expect(user.text).not.toContain("�");
});

test("at most eight events and 16 KB go into one step; the rest waits", async () => {
	const h = await setup();
	const body = "い".repeat(1500);
	for (let i = 0; i < 5; i++) await h.exchange(`${body}${i}`, `${body}${i}`);
	h.inference.script("curate-memory", empty, empty, empty, empty, empty);
	await h.drain();
	const sizes = h.inference
		.callsOf("curate-memory")
		.map((c) => (c.data.events as unknown[]).length);
	expect(sizes[0]).toBeLessThanOrEqual(8);
	const bytes = (
		h.inference.callsOf("curate-memory")[0]!.data.events as Array<{
			text: string;
		}>
	).reduce((sum, e) => sum + new TextEncoder().encode(e.text).length, 0);
	expect(bytes).toBeLessThanOrEqual(16 * 1024);
	expect(sizes.reduce((a, b) => a + b, 0)).toBe(10);
	expect(curated(h).every(Boolean)).toBe(true);
});

test("the turns of the events are embedded beside the inference and saved when the step is adopted", async () => {
	const h = await setup({ embed: topicEmbed });
	h.inference.script("curate-memory", empty);
	const run = await h.exchange("辛いものが好きです", "そうなんですね");
	await h.drain();
	const vector = await h.memory.vectors.embedQuery(
		"辛いもの",
		new AbortController().signal,
	);
	expect(vector).not.toBeNull();
	const found = h.store.read((db) =>
		h.memory.recallTurnsInRead(db, {
			conversationId: "c1",
			space: vector!.space,
			vector: vector!.vector,
			limit: 3,
			minScore: 0,
			excludeMessageIds: [],
		}),
	);
	expect(found?.pins.map((pin) => pin.messageId)).toContain(run.inputMessageId);
});

test("long-term writers share one concurrency key across conversations", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty, empty);
	await h.exchange("a", "b", { conversationId: "c1" });
	await h.exchange("c", "d", { conversationId: "c2" });
	await h.drain();
	const keys = h.store.read((db) =>
		db
			.query(
				"SELECT json_extract(payload_json,'$.unitId') AS unitId, concurrency_key AS key FROM queue_jobs",
			)
			.all(),
	) as Array<{ unitId: string; key: string }>;
	const byStep = new Map(h.units().map((u) => [u.id, u.step]));
	const pairs = keys.map((k) => [byStep.get(k.unitId), k.key]);
	const curates = pairs.filter(([s]) => s === "curate-memory");
	expect(curates).toHaveLength(2);
	expect(curates.every(([, k]) => k === "steward:long-term")).toBe(true);
});

test("no sleep layer: a long quiet spell asks no model and makes no unit", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty);
	await h.exchange("こんにちは", "こんにちは");
	await h.drain();
	const before = h.units().length;
	await h.rest(24 * 3_600_000);
	expect(h.units()).toHaveLength(before);
	expect(h.units().every((u) => u.step === "curate-memory")).toBe(true);
});
