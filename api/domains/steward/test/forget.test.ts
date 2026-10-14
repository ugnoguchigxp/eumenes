import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ForgetPurge } from "../../memory";
import { createStewardService } from "../service";
import {
	keepAll,
	setupSteward,
	topicEmbed,
	type StewardHarness,
} from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	const h = await setupSteward({ embed: topicEmbed });
	harnesses.push(h);
	return h;
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const address = {
	kind: "personal_fact",
	key: "address",
	text: "住所は東京都千代田区",
	evidence: "e1",
	quote: null,
	validFrom: null,
	validUntil: null,
	negated: false,
};
const resolve = (over: Record<string, unknown>) => ({
	request: "r1",
	action: "forget",
	refs: [],
	alsoIn: [],
	text: null,
	kind: null,
	key: null,
	...over,
});
async function learnAddress(h: StewardHarness) {
	h.inference.script("curate-memory", { ...empty, remember: [address] });
	h.inference.script("dispose-exchanges", keepAll);
	const first = await h.run({
		user: "私の住所は東京都千代田区です",
		answer: "住所を承知しました",
		end: "completed",
	});
	await h.drain();
	return first;
}

test("a forget request erases the memory and blocks the exchanges, and nothing else of the steward keeps the words", async () => {
	const h = await setup();
	const first = await learnAddress(h);
	expect(h.memory.list().map((i) => i.semanticKey)).toEqual(["address"]);
	const learned = h.steward
		.decisions("c1")
		.filter((d) => d.step === "curate-memory");
	expect(learned).toHaveLength(1);

	h.inference.script("curate-memory", (data) => {
		// The earlier talk about the address is offered as a candidate (found by meaning).
		const candidates = data.candidates as Array<Record<string, unknown>>;
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			id: "c1",
			user: "私の住所は東京都千代田区です",
		});
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		return { ...empty, resolve: [resolve({ refs: [ref], alsoIn: ["c1"] })] };
	});
	h.inference.script("dispose-exchanges", keepAll);
	await h.run({
		user: "住所を忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "住所" }],
	});
	await h.drain();

	expect(
		h.memory.list(true).filter((i) => i.semanticKey === "address"),
	).toEqual([]);
	const blocked = h.memory.blockedMessageIds([
		first.inputMessageId,
		first.answerMessageId!,
	]);
	expect(blocked.size).toBe(2);
	expect(h.exchangeRow(first.inputMessageId)!.disposition).toBe("drop");
	// The conversation's original stays.
	expect(h.conversation.message(first.inputMessageId)?.text).toBe(
		"私の住所は東京都千代田区です",
	);
	// The decision that saved the address is gone; the forgetting step keeps no body.
	const decisions = h.steward.decisions("c1");
	const curate = decisions.filter((d) => d.step === "curate-memory");
	expect(curate.map((d) => d.output)).toEqual([{ redacted: "forgotten" }]);
	expect(JSON.stringify(decisions)).not.toContain("千代田区");
	// The request's words are cleared.
	expect(h.inbox()).toMatchObject([{ state: "done", what: "", detail: null }]);
	// The steps that ran after the forget are not shown the forgotten exchange.
	const after = h.inference.calls
		.filter((c) => c.step !== "curate-memory")
		.slice(-2);
	expect(JSON.stringify(after)).not.toContain("千代田区");
});

test("an answer that stood on ground a forget removed is not adopted, and leaves no body", async () => {
	const h = await setup();
	await learnAddress(h);
	const item = h.memory.list()[0]!;
	h.inference.script("curate-memory", async () => {
		await h.memory.forget({
			conversationId: "c1",
			itemIds: [item.id],
			messageIds: [],
		});
		return {
			...empty,
			remember: [
				{ ...address, key: "food.spicy", text: "辛い物が好き", evidence: "e1" },
			],
		};
	});
	h.inference.script("curate-memory", empty);
	h.inference.script("dispose-exchanges", keepAll);
	await h.run({ user: "辛いものが好きです", end: "completed" });
	await h.drain();
	const units = h.units().filter((u) => u.step === "curate-memory");
	expect(units.map((u) => u.state)).toEqual(["applied", "stale", "applied"]);
	const stale = h.steward
		.decisions("c1")
		.find((d) => d.errorCode === "stale_forget")!;
	expect(stale).toMatchObject({
		step: "curate-memory",
		output: null,
		results: null,
	});
	// The stale answer's memory was not saved; the unit was made again and ran on the new state.
	expect(h.memory.list().map((i) => i.semanticKey)).toEqual([]);
	expect(h.inference.callsOf("curate-memory")).toHaveLength(3);
	expect(h.inference.statuses("pending")).toBe(0);
});

test("a summary written after prepare makes an older rewrite stale", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty, empty);
	h.inference.script("dispose-exchanges", {
		exchanges: [{ id: "e1", action: "summarize", duplicateOf: null }],
	});
	h.inference.script(
		"summarize",
		async () => {
			await h.store.write((db) =>
				h.memory.writeSummaryInTransaction(db, {
					conversationId: "c1",
					text: "別の経路で書かれた要約",
					included: [],
					expectedRevision: 0,
				}),
			);
			return { summary: "古い土台の要約", included: ["e1"] };
		},
		{ summary: "新しい土台の要約", included: ["e1"] },
	);
	const { inputMessageId } = await h.run({ user: "a", end: "completed" });
	await h.drain();
	const stale = h.steward
		.decisions("c1")
		.find((d) => d.errorCode === "stale_summary")!;
	expect(stale).toMatchObject({ step: "summarize", output: null });
	const summary = h.store.read((db) => h.memory.summaryInTransaction(db, "c1"));
	expect(summary).toMatchObject({ text: "新しい土台の要約", revision: 2 });
	expect(summary!.sources).toEqual([inputMessageId]);
});

test("a prefetch prepared before a forget is not published", async () => {
	const h = await setup();
	await learnAddress(h);
	const item = h.memory.list()[0]!;
	const before = h.store.read((db) =>
		h.memory.windows.storedInTransaction(db, "c1"),
	)!.prefetch;
	h.inference.script("prepare-recall", async () => {
		await h.memory.forget({
			conversationId: "c1",
			itemIds: [item.id],
			messageIds: [],
		});
		return { query: "住所" };
	});
	h.inference.script("curate-memory", empty);
	h.inference.script("dispose-exchanges", keepAll);
	await h.run({ user: "次の話", end: "completed" });
	await h.drain();
	expect(
		h.steward
			.decisions("c1")
			.some(
				(d) => d.step === "prepare-recall" && d.errorCode === "stale_forget",
			),
	).toBe(true);
	const after = h.store.read((db) =>
		h.memory.windows.storedInTransaction(db, "c1"),
	)!.prefetch;
	expect(after).toEqual(before);
});

test("the purge is idempotent: running it again changes nothing", async () => {
	const h = await setup();
	const first = await learnAddress(h);
	const item = h.memory.list()[0]!;
	const hooks: Array<(db: Database, purge: ForgetPurge) => void> = [];
	createStewardService({
		store: h.store,
		memory: {
			...h.memory,
			registerForgetPurge: (hook) => void hooks.push(hook),
		},
		conversation: h.conversation,
		continuity: h.continuity,
		queue: h.queue,
		inference: h.inference.port,
		foregroundActive: () => false,
		runStateOf: () => "stale",
		clock: () => new Date(h.time.ms).toISOString(),
		nowMs: () => h.time.ms,
		newId: () => crypto.randomUUID(),
	});
	const purge = {
		conversationId: "c1",
		itemIds: [item.id],
		messageIds: [first.inputMessageId],
		deletedSummaryConversationIds: [],
	};
	await h.store.write((db) => {
		hooks[0]!(db, purge);
		hooks[0]!(db, purge);
	});
	expect(
		h.steward
			.decisions("c1")
			.some((d) => JSON.stringify(d).includes("千代田区")),
	).toBe(false);
	await h.store.write((db) => hooks[0]!(db, purge));
});
