import { afterEach, expect, test } from "bun:test";
import { type StewardHarness, keepAll, setupSteward } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	const h = await setupSteward();
	harnesses.push(h);
	return h;
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
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
const keep = (id = "e1") => ({
	exchanges: [{ id, action: "keep", duplicateOf: null }],
});

test("one exchange goes through curate, dispose and summarize and is done", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [remember({ quote: "辛いものが好きです" })],
	});
	h.inference.script("dispose-exchanges", keep());
	const { inputMessageId } = await h.exchange(
		"辛いものが好きです",
		"覚えておきます",
	);
	await h.drain();
	expect(h.exchangeRow(inputMessageId)).toMatchObject({
		curated: "done",
		disposed: "done",
		summarized: "done",
		disposition: "keep",
		state: "done",
	});
	expect(h.memory.list().map((item) => item.text)).toEqual([
		"辛い食べ物が好き",
	]);
	expect(h.units().map((unit) => [unit.step, unit.state])).toEqual([
		["curate-memory", "applied"],
		["dispose-exchanges", "applied"],
		["prepare-recall", "applied"],
	]);
	const decisions = h.steward.decisions("c1");
	expect(decisions.map((d) => d.step)).toEqual([
		"prepare-recall",
		"dispose-exchanges",
		"curate-memory",
	]);
	expect(decisions.every((d) => d.windowVersionAfter !== null)).toBe(true);
	expect(decisions.every((d) => d.durationMs !== null)).toBe(true);
	expect(h.inference.statuses("pending")).toBe(0);
	// Nothing is left to do: a kick makes no unit.
	await h.kick();
	expect(h.units()).toHaveLength(3);
});

test("a failed summarize is run again without saving the memory twice", async () => {
	const h = await setup();
	h.inference.script("curate-memory", { ...empty, remember: [remember()] });
	h.inference.script("dispose-exchanges", {
		exchanges: [{ id: "e1", action: "summarize", duplicateOf: null }],
	});
	h.inference.script("summarize", new Error("unusable_answer"), {
		summary: "辛い物の話をした。",
		included: ["e1"],
	});
	const { inputMessageId } = await h.exchange("辛いものが好きです", "了解");
	await h.drain();
	expect(h.inference.callsOf("curate-memory")).toHaveLength(1);
	expect(h.inference.callsOf("summarize")).toHaveLength(2);
	expect(h.memory.list()).toHaveLength(1);
	expect(h.exchangeRow(inputMessageId)).toMatchObject({
		summarized: "done",
		disposition: "summarize",
		state: "done",
	});
	const summary = h.store.read((db) => h.memory.summaryInTransaction(db, "c1"));
	expect(summary).toMatchObject({
		text: "辛い物の話をした。",
		sources: [inputMessageId],
	});
	const states = h.units().map((unit) => `${unit.step}:${unit.state}`);
	expect(states).toContain("summarize:failed");
	expect(states).toContain("summarize:applied");
});

test("three unusable answers over a target skip its step and the pipeline goes on", async () => {
	const h = await setup();
	h.inference.script("curate-memory", "not json", "{]", "[]");
	h.inference.script("dispose-exchanges", keep());
	const { inputMessageId } = await h.exchange("こんにちは", "こんにちは");
	await h.drain();
	const row = h.exchangeRow(inputMessageId)!;
	expect(row).toMatchObject({
		curated: "skipped",
		disposed: "done",
		state: "done",
	});
	expect(row.failures.curated).toBe(3);
	expect(h.memory.list()).toEqual([]);
	expect(
		h
			.units()
			.filter((u) => u.step === "curate-memory")
			.map((u) => u.state),
	).toEqual(["failed", "failed", "failed"]);
});

test("a result of a step that already carries its mark is not applied again", async () => {
	const h = await setup();
	h.inference.script("curate-memory", { ...empty, remember: [remember()] });
	h.inference.script("dispose-exchanges", keep());
	const { inputMessageId } = await h.exchange("辛いものが好きです", "了解");
	await h.drain();
	const before = h.memory.list(true);
	// Another run's unit over the same exchange: its target already has the mark.
	await h.store.write((db) =>
		h.steward.stageRequestInTransaction(db, {
			requestId: "r-x",
			conversationId: "c1",
			runId: "run-x",
			messageId: inputMessageId,
			kind: "remember",
			what: "x",
		}),
	);
	await h.runEnded("run-x", "c1", "cancelled");
	h.inference.script("curate-memory", {
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
	});
	await h.drain();
	expect(h.memory.list(true)).toEqual(before);
	expect(h.exchangeRow(inputMessageId)!.curated).toBe("done");
});

test("long-term writers share one concurrency key; the rest are per conversation", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty, empty);
	h.inference.script("dispose-exchanges", keep(), keep());
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
	expect(
		pairs
			.filter(([s]) => s === "curate-memory")
			.every(([, k]) => k === "steward:long-term"),
	).toBe(true);
	expect(
		pairs
			.filter(([s]) => s === "dispose-exchanges")
			.map(([, k]) => k)
			.sort(),
	).toEqual(["steward:c1", "steward:c2"]);
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
	h.inference.script("dispose-exchanges", keep());
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

test("the evidence is the user message, found by quote or else the whole message", async () => {
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
		],
	});
	h.inference.script("dispose-exchanges", keep());
	const { inputMessageId } = await h.exchange("辛いものが好きです", "なるほど");
	await h.drain();
	const items = h.memory.list();
	expect(items.every((i) => i.sourceMessageIds.join() === inputMessageId)).toBe(
		true,
	);
	const results = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-memory")!.results as Array<{
		quoteMatched: boolean;
	}>;
	expect(results.map((r) => r.quoteMatched)).toEqual([true, false]);
});

test("dispose: the older of two repeats leaves the verbatim history", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty, empty);
	h.inference.script("dispose-exchanges", keep());
	const first = await h.exchange("今日の天気は？", "晴れです");
	await h.drain();
	h.inference.script("dispose-exchanges", (data) => {
		const listed = (data.keepList as Array<{ id: string }>)[0]!.id;
		return { exchanges: [{ id: "e1", action: "keep", duplicateOf: listed }] };
	});
	const second = await h.exchange("今日の天気は？", "晴れです");
	await h.drain();
	expect(h.exchangeRow(first.inputMessageId)!.disposition).toBe("drop");
	expect(h.exchangeRow(second.inputMessageId)).toMatchObject({
		disposition: "keep",
		duplicateOf: first.inputMessageId,
	});
});

test("a failed attempt reaches curate-memory as an exchange without an answer", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty);
	h.inference.script("dispose-exchanges", {
		exchanges: [{ id: "e1", action: "drop", duplicateOf: null }],
	});
	const { inputMessageId } = await h.exchange("予算は3万円以内で", null);
	await h.drain();
	const call = h.inference.callsOf("curate-memory")[0]!;
	const view = (call.data.exchanges as Array<Record<string, unknown>>)[0]!;
	expect(view).toMatchObject({ outcome: "failed", assistant: null });
	expect(h.exchangeRow(inputMessageId)).toMatchObject({
		outcome: "failed",
		disposition: "drop",
	});
});

test("long messages are cut to 6 KB for the steward, and an exchange always fits", async () => {
	const h = await setup();
	const long = "あ".repeat(4000);
	h.inference.script("curate-memory", empty);
	h.inference.script("dispose-exchanges", keep());
	await h.exchange(`先頭${long}末尾`, `${long}答え`);
	await h.drain();
	const view = (
		h.inference.callsOf("curate-memory")[0]!.data.exchanges as Array<
			Record<string, any>
		>
	)[0]!;
	expect(view.userTruncated).toBe(true);
	expect(view.assistantTruncated).toBe(true);
	expect(view.user).toContain("（中略）");
	expect(view.user.startsWith("先頭")).toBe(true);
	expect(view.user.endsWith("末尾")).toBe(true);
	expect(new TextEncoder().encode(view.user).length).toBeLessThanOrEqual(
		6 * 1024 + 32,
	);
	expect(view.user).not.toContain("�");
});

test("at most four exchanges and 16 KB go into one step; the rest waits", async () => {
	const h = await setup();
	const body = "い".repeat(1500);
	for (let i = 0; i < 5; i++) await h.exchange(`${body}${i}`, `${body}${i}`);
	h.inference.script("curate-memory", empty, empty, empty, empty, empty);
	h.inference.script(
		"dispose-exchanges",
		keepAll,
		keepAll,
		keepAll,
		keepAll,
		keepAll,
	);
	await h.drain();
	const sizes = h.inference
		.callsOf("curate-memory")
		.map((c) => (c.data.exchanges as unknown[]).length);
	expect(sizes[0]).toBeLessThanOrEqual(4);
	const bytes = (
		h.inference.callsOf("curate-memory")[0]!.data.exchanges as Array<{
			user: string;
			assistant: string;
		}>
	).reduce(
		(sum, e) => sum + new TextEncoder().encode(e.user + e.assistant).length,
		0,
	);
	expect(bytes).toBeLessThanOrEqual(16 * 1024);
	expect(sizes.reduce((a, b) => a + b, 0)).toBe(5);
});

test("a skipped dispose closes the summarize step with it, so the exchange still ends up done", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty);
	h.inference.script("dispose-exchanges", "x", "x", "x");
	const { inputMessageId } = await h.exchange("やあ", "どうも");
	await h.drain();
	expect(h.exchangeRow(inputMessageId)).toMatchObject({
		curated: "done",
		disposed: "skipped",
		summarized: "skipped",
		disposition: null,
		state: "done",
	});
});
