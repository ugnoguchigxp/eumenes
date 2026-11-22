import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ForgetPurge } from "../../memory";
import { createStewardService } from "../service";
import {
	setupSteward,
	topicEmbed,
	type StewardHarness,
} from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	const h = await setupSteward({ embed: topicEmbed, sleep: {} });
	harnesses.push(h);
	return h;
}
const empty = { resolve: [] };
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
/** The exchange where the address was said, and the memory the earlier reflection kept of it (turns embedded). */
async function learnAddress(h: StewardHarness) {
	const first = await h.run({
		user: "私の住所は東京都千代田区です",
		answer: "住所を承知しました",
		end: "completed",
	});
	await h.store.write((db) =>
		h.memory.applyCurationInTransaction(db, {
			conversationId: "c1",
			items: [
				{
					op: "remember",
					kind: "personal_fact",
					key: "address",
					text: "住所は東京都千代田区",
					messageId: first.inputMessageId,
					quote: null,
				},
			],
		}),
	);
	// The sleep layer embeds the turns of the handled events once the conversation rests.
	await h.rest();
	return first;
}

test("a forget request can identify and erase an inactive memory", async () => {
	const h = await setup();
	await learnAddress(h);
	const stopped = h.memory.list()[0]!;
	await h.store.write((db) =>
		h.memory.applyCurationInTransaction(db, {
			conversationId: "c1",
			items: [{ op: "stop", itemId: stopped.id, revision: stopped.revision }],
		}),
	);
	expect(h.memory.list()).toEqual([]);
	expect(h.memory.list(true)[0]!.status).toBe("inactive");
	h.inference.script("curate-memory", (data) => {
		const item = (
			data.longTerm as Array<{ ref: string; status: string; text: string }>
		).find((item) => item.text.includes("千代田区"));
		expect(item?.status).toBe("inactive");
		return { ...empty, resolve: [resolve({ refs: [item!.ref] })] };
	});
	await h.run({
		user: "停止した住所の記憶も忘れてください",
		end: "completed",
		requests: [{ kind: "forget", what: "住所の記憶" }],
	});
	await h.drain();
	expect(
		h.memory.list(true).filter((item) => item.semanticKey === "address"),
	).toEqual([]);
	expect(h.inbox().at(-1)?.state).toBe("done");
});

test("a fact with more than five versions uses one forget reference and erases every version", async () => {
	const h = await setup();
	await learnAddress(h);
	for (let version = 1; version <= 5; version++) {
		const text = `住所は東京都千代田区の${version}番地`;
		const said = await h.run({ user: text, end: "completed" });
		const current = h.memory.list()[0]!;
		await h.store.write((db) =>
			h.memory.applyCurationInTransaction(db, {
				conversationId: "c1",
				items: [
					{
						op: "update",
						itemId: current.id,
						revision: current.revision,
						text,
						messageId: said.inputMessageId,
						quote: null,
					},
				],
			}),
		);
	}
	expect(h.memory.list(true)).toHaveLength(6);
	h.inference.script("curate-memory", (data) => {
		const items = data.longTerm as Array<{ ref: string; versions: unknown[] }>;
		expect(items).toHaveLength(1);
		expect(items[0]!.versions).toHaveLength(6);
		return { ...empty, resolve: [resolve({ refs: [items[0]!.ref] })] };
	});
	await h.run({
		user: "住所の記憶を過去の版も忘れてください",
		end: "completed",
		requests: [{ kind: "forget", what: "住所の全版" }],
	});
	await h.drain();
	expect(h.memory.list(true)).toEqual([]);
	expect(h.inbox().at(-1)?.state).toBe("done");
});

test("a forget request erases the memory and blocks the exchanges, and nothing else of the steward keeps the words", async () => {
	const h = await setup();
	const first = await learnAddress(h);
	expect(h.memory.list().map((i) => i.semanticKey)).toEqual(["address"]);

	const callsBefore = h.inference.calls.length;
	h.inference.script("curate-memory", (data) => {
		// The earlier talk about the address is offered as a candidate (found by meaning).
		const candidates = data.candidates as Array<Record<string, unknown>>;
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			id: "xc1",
			user: "私の住所は東京都千代田区です",
		});
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		return { ...empty, resolve: [resolve({ refs: [ref], alsoIn: ["xc1"] })] };
	});
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
	// The events that showed the messages keep only that they existed.
	expect(
		h
			.log()
			.filter((e) => e.messageIds.some((id) => blocked.has(id)))
			.map((e) => e.forgotten),
	).toEqual([true, true]);
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
	// No step after the forget is shown the forgotten events.
	const after = h.inference.calls
		.slice(callsBefore)
		.filter((c) => c.step !== "curate-memory");
	expect(JSON.stringify(after)).not.toContain("千代田区");
});

test("an answer that stood on ground a forget removed is not adopted, and leaves no body", async () => {
	const h = await setup();
	await learnAddress(h);
	const item = h.memory.list()[0]!;
	const answer = {
		resolve: [
			resolve({
				action: "remember",
				kind: "preference",
				key: "food.spicy",
				text: "辛い物が好き",
			}),
		],
	};
	h.inference.script(
		"curate-memory",
		async () => {
			await h.memory.forget({
				conversationId: "c1",
				itemIds: [item.id],
				messageIds: [],
			});
			return answer;
		},
		answer,
	);
	await h.run({
		user: "辛いものが好きです。覚えて",
		end: "completed",
		requests: [{ kind: "remember", what: "辛い物が好き" }],
	});
	await h.drain();
	const units = h.units().filter((u) => u.step === "curate-memory");
	expect(units.map((u) => u.state)).toEqual(["stale", "applied"]);
	const stale = h.steward
		.decisions("c1")
		.find((d) => d.errorCode === "stale_forget")!;
	expect(stale).toMatchObject({
		step: "curate-memory",
		output: null,
		results: null,
	});
	// The stale answer was not adopted; the unit was made again and ran on the new state.
	expect(h.memory.list().map((i) => i.semanticKey)).toEqual(["food.spicy"]);
	expect(h.inference.callsOf("curate-memory")).toHaveLength(2);
	expect(h.inference.statuses("pending")).toBe(0);
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
		conversationOnLarm: () => true,
		foregroundActive: () => false,
		restMs: () => 10_000,
		runStateOf: () => "stale",
		clock: () => new Date(h.time.ms).toISOString(),
		nowMs: () => h.time.ms,
		newId: () => crypto.randomUUID(),
	});
	const purge = {
		conversationId: "c1",
		itemIds: [item.id],
		messageIds: [first.inputMessageId],
		derived: {},
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
