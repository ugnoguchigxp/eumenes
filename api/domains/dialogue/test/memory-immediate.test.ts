import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { testConversationAgent } from "./conversation-agent.fixture";
import {
	choice,
	reply,
	sectionLines,
	setup,
	type Call,
	type Harness,
} from "./generation.fixture";
import { saveItem } from "./memory-seed";

/**
 * The `memory` tool through the memory's immediate layer (the memory architecture redesign, sections 5.1, 7.2 and
 * 9.2): each kind is applied in the run's own writer transaction, the result goes back to the model in the same
 * reply, and the run's own changes never expire it.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const SPICY = "辛いものが好き";

const toolResult = (call: Call) =>
	[...call.messages].reverse().find((m) => (m.role as string) === "tool")
		?.content ?? "";
const memoryCall = (args: Record<string, unknown>) => ({
	calls: [{ name: "memory", args: { operation: "request", ...args } }],
});
const remember = (text: string, key: string, quote = text) =>
	memoryCall({
		kind: "remember",
		what: text,
		quote,
		memory: { kind: "preference", semanticKey: key, text },
	});

async function open() {
	h = await setup({
		memory: true,
		conversationAgent: { ...testConversationAgent, handsWork: () => false },
	});
	return h;
}

/** Saves a fact the user said, then republishes the window so `## Memory` shows it as `m1`. */
async function shownFact(text = SPICY, key = "food.spicy") {
	h!.state.steps.unshift(...reply("覚えました。"));
	const first = await h!.say(text, "completed");
	const saved = await saveItem(h!.store, h!.memory!, {
		conversationId: "main",
		messageId: first.inputMessageId,
		quote: text,
		kind: "preference",
		semanticKey: key,
		text,
	});
	await h!.memory!.setEnabled(false);
	await h!.memory!.setEnabled(true);
	return { saved, first };
}

/** The memory section the latest generation call showed. */
const memorySection = () =>
	h!.state.calls
		.at(-1)!
		.messages.flatMap((m) => sectionLines(m.content, "Memory"));

test("a remembered fact is saved at once with its reference, and the next utterance reads it", async () => {
	await open();
	h!.state.steps.push(
		choice({ choice: "none" }),
		remember("鍵は靴箱の上", "home.key", "覚えといて、鍵は靴箱の上"),
		{ text: "覚えました。" },
	);
	const run = await h!.say("覚えといて、鍵は靴箱の上");
	const result = toolResult(h!.state.calls.at(-1)!);
	expect(result).toContain('"status":"applied"');
	expect(result).toContain('"ref":"m1"');
	// Its own change does not expire the reply that made it.
	expect(h!.dialogue.get(run.id)?.error).toBeNull();
	expect(h!.dialogue.answerText(run.id)).toBe("覚えました。");
	expect(h!.state.stewardRequests).toEqual([]);
	h!.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_memory", args: { query: "鍵は靴箱" } }] },
		{ text: "靴箱の上です。" },
	);
	await h!.say("鍵どこ？");
	expect(toolResult(h!.state.calls.at(-1)!)).toContain("- m1 鍵は靴箱の上");
});

test("a quote that is not the user's words is refused with its reason, and the model repairs it in the same reply", async () => {
	await open();
	h!.state.steps.push(
		choice({ choice: "none" }),
		remember("鍵は靴箱の上", "home.key", "鍵は玄関の棚"),
		remember("鍵は靴箱の上", "home.key", "鍵は靴箱の上"),
		{ text: "覚えました。" },
	);
	const run = await h!.say("覚えといて、鍵は靴箱の上");
	const calls = h!.state.calls;
	expect(toolResult(calls.at(-2)!)).toContain('"reason":"quote_mismatch"');
	expect(toolResult(calls.at(-2)!)).toContain('"accepted":false');
	expect(toolResult(calls.at(-1)!)).toContain('"status":"applied"');
	expect(h!.memory!.list().map((item) => item.text)).toEqual(["鍵は靴箱の上"]);
	expect(h!.dialogue.answerText(run.id)).toBe("覚えました。");
});

test("arguments the tool needs are asked for by field, and a reference never handed out is refused", async () => {
	await open();
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "remember", what: "鍵は靴箱の上" }),
		memoryCall({ kind: "suppress", what: "鍵の話", ref: "m9" }),
		{ text: "できませんでした。" },
	);
	await h!.say("覚えといて、鍵は靴箱の上");
	const calls = h!.state.calls;
	expect(toolResult(calls.at(-2)!)).toContain("quote");
	expect(toolResult(calls.at(-1)!)).toContain("unknown_ref");
	expect(h!.memory!.list()).toEqual([]);
});

test("a correction by reference replaces the version and answers with the new one; the same target asked again in other words is the first", async () => {
	await open();
	await shownFact();
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({
			kind: "correct",
			what: "辛いものの好みを変える",
			ref: "m1",
			quote: "甘いものが好き",
			memory: { text: "甘いものが好き" },
		}),
		memoryCall({
			kind: "correct",
			what: "もう一度",
			ref: "m1",
			quote: "甘いものが好き",
			memory: { text: "苦いものが好き" },
		}),
		{ text: "直しました。" },
	);
	await h!.say("甘いものが好きに変わったよ");
	const calls = h!.state.calls;
	expect(toolResult(calls.at(-2)!)).toContain('"status":"applied"');
	expect(toolResult(calls.at(-1)!)).toContain('"status":"applied"');
	// Applied once: the second call is the first one asked again.
	expect(h!.memory!.list().map((item) => item.text)).toEqual([
		"甘いものが好き",
	]);
	// The old version stays as history.
	expect(h!.memory!.list(true).map((item) => item.text)).toContain(SPICY);
});

test("a reference of an earlier window is refused after the window changed, and the new window numbers on", async () => {
	await open();
	await shownFact();
	// The window changes: another fact joins the profile, which is published again.
	h!.state.steps.unshift(...reply("覚えました。"));
	const second = await h!.say("甘いものも好き", "completed");
	await saveItem(h!.store, h!.memory!, {
		conversationId: "main",
		messageId: second.inputMessageId,
		quote: "甘いものも好き",
		kind: "preference",
		semanticKey: "food.sweet",
		text: "甘いものも好き",
	});
	await h!.memory!.setEnabled(false);
	await h!.memory!.setEnabled(true);
	h!.state.steps.push(
		choice({ choice: "none" }),
		// `m1` is what an earlier prompt of this conversation showed.
		memoryCall({ kind: "forget", what: "辛いもの", ref: "m1" }),
		{ text: "できませんでした。" },
	);
	await h!.say("辛いものを忘れて");
	// The new window's references go on from the old ones: none is handed out twice.
	const shown = memorySection().join("\n");
	expect(shown).not.toMatch(/- m1 /);
	expect(shown).toMatch(/- m\d+ /);
	expect(toolResult(h!.state.calls.at(-1)!)).toContain(
		'"reason":"unknown_ref"',
	);
	expect(h!.state.excluded).toEqual([]);
	expect(h!.memory!.list().map((item) => item.text)).toContain(SPICY);
});

test("a forget by reference excludes at once: the input, read_memory and read_history lose it, and the steward waits for the closure", async () => {
	await open();
	const { saved, first } = await shownFact();
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "forget", what: "辛いものの好み", ref: "m1" }),
		{ text: "忘れました。" },
	);
	const run = await h!.say("辛いものの話は忘れて");
	const calls = h!.state.calls;
	// Its own forget does not expire the reply that made it, though the words were in its prompt.
	expect(toolResult(calls.at(-1)!)).toContain('"status":"applied"');
	expect(h!.dialogue.get(run.id)?.error).toBeNull();
	expect(h!.dialogue.answerText(run.id)).toBe("忘れました。");
	// The steward's inbox keeps the request as excluded, with the records and the messages they stand on.
	expect(h!.state.stewardRequests).toEqual([
		expect.objectContaining({ kind: "forget", sourceRef: run.inputMessageId }),
	]);
	expect(h!.state.excluded).toEqual([
		expect.objectContaining({
			id: "request:1",
			conversationId: "main",
			exclusion: expect.objectContaining({
				itemIds: [saved.id],
				messageIds: [first.inputMessageId],
			}),
		}),
	]);
	expect(h!.memory!.list()).toEqual([]);
	// The next utterance reads neither memory nor history for it.
	h!.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_memory", args: {} }] },
		{ calls: [{ name: "read_history", args: { query: "辛い" } }] },
		{ text: "ありません。" },
	);
	await h!.say("何か覚えてる？");
	const read = h!.state.calls;
	expect(memorySection().join("\n")).not.toContain(SPICY);
	expect(toolResult(read.at(-2)!)).not.toContain(SPICY);
	expect(toolResult(read.at(-1)!)).not.toContain(SPICY);
	const hidden = h!.store.read(
		(db) =>
			db.query("SELECT message_id FROM dialogue_forget_hidden").all() as {
				message_id: string;
			}[],
	);
	expect(hidden.map((row) => row.message_id)).toEqual([first.inputMessageId]);
});

test("the steward's closure delete, started at once by the run's own forget, does not take the reply away: it is answered, and a retry would still carry the request", async () => {
	await open();
	const { saved, first } = await shownFact();
	// The steward does not wait for the run: its closure delete blocks the messages while the reply is written.
	h!.state.onExcluded = (db, input) => {
		h!.memory!.closeExclusionInTransaction(db, {
			conversationId: input.conversationId,
			itemIds: input.exclusion.itemIds,
			messageIds: input.exclusion.messageIds,
		});
	};
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "forget", what: "辛いものの好み", ref: "m1" }),
		{ text: "忘れました。" },
	);
	const run = await h!.say("辛いものの話は忘れて");
	expect(h!.dialogue.get(run.id)?.error).toBeNull();
	expect(h!.dialogue.answerText(run.id)).toBe("忘れました。");
	expect(h!.memory!.list(true).map((item) => item.id)).not.toContain(saved.id);
	expect(
		h!.store.read((db) =>
			h!.memory!.blockedMessageIdsInTransaction(db, [first.inputMessageId]),
		),
	).toEqual(new Set([first.inputMessageId]));
});

test("a reply made again after the run's own forget still shows the user's request", async () => {
	await open();
	await shownFact();
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "forget", what: "辛いものの好み", ref: "m1" }),
		// The closure delete revoked the call that made the forget: the host writes the reply again.
		{ fail: "memory_stale" },
		choice({ choice: "none" }),
		{ text: "忘れました。" },
	);
	const run = await h!.say("辛いものの話は忘れて");
	expect(h!.dialogue.answerText(run.id)).toBe("忘れました。");
	// The retry's input is the request itself, not a line of the history under a host notice.
	const again = h!.state.calls.at(-1)!;
	const last = String(again.messages.at(-1)!.content);
	expect(last).toContain("## User\n辛いものの話は忘れて");
	expect(last).not.toContain("## Earlier");
	expect(again.tools).toContain("memory");
});

test("a forget that names no reference is queued for the agency to resolve, and the model is told it is resolving", async () => {
	await open();
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "forget", what: "元カノの話は全部" }),
		{ text: "対象を探します。" },
	);
	const run = await h!.say("元カノの話は全部忘れて");
	expect(toolResult(h!.state.calls.at(-1)!)).toContain('"status":"resolving"');
	expect(h!.state.targetRequests).toEqual([
		expect.objectContaining({
			kind: "forget",
			what: "元カノの話は全部",
			runId: run.id,
			requestId: expect.any(String),
		}),
	]);
	// The same request waits in the steward's inbox, not yet excluded.
	expect(h!.state.stewardRequests).toEqual([
		expect.objectContaining({ kind: "forget" }),
	]);
	expect(h!.state.excluded).toEqual([]);
	expect(h!.state.stewardRequests[0]!.requestId).toBe(
		h!.state.targetRequests[0]!.requestId,
	);
});

test("without the target resolution port a request that names no reference is refused", async () => {
	h = await setup({
		memory: true,
		memoryTargets: null,
		conversationAgent: { ...testConversationAgent, handsWork: () => false },
	});
	h.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "suppress", what: "元カノの話" }),
		{ text: "できません。" },
	);
	await h.say("元カノの話は出さないで");
	expect(toolResult(h.state.calls.at(-1)!)).toContain(
		"target_resolution_unavailable",
	);
});

test("a suppression keeps the record but drops it from the next `## Memory`; read_memory says not to bring it up", async () => {
	await open();
	await shownFact();
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "suppress", what: "辛いものの話", ref: "m1" }),
		{ text: "出しません。" },
	);
	await h!.say("辛いものの話はもう出さないで");
	expect(toolResult(h!.state.calls.at(-1)!)).toContain('"status":"applied"');
	await h!.memory!.setEnabled(false);
	await h!.memory!.setEnabled(true);
	h!.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_memory", args: {} }] },
		{ text: "はい。" },
	);
	await h!.say("夕食の候補は？");
	expect(memorySection().join("\n")).not.toContain(SPICY);
	const read = toolResult(h!.state.calls.at(-1)!);
	expect(read).toContain(SPICY);
	expect(read).toContain("話題にしない");
	expect(read).not.toContain("- m1");
});

test("a withdrawal takes back the remember of the same conversation", async () => {
	await open();
	h!.state.steps.push(
		choice({ choice: "none" }),
		remember("鍵は靴箱の上", "home.key"),
		memoryCall({ kind: "withdraw", what: "さっきの依頼" }),
		{ text: "取り消しました。" },
	);
	await h!.say("覚えといて、鍵は靴箱の上。やっぱり取り消して");
	expect(toolResult(h!.state.calls.at(-1)!)).toContain('"status":"applied"');
	expect(h!.memory!.list()).toEqual([]);
});

test("a call repeated with the same arguments (as a retried generation does) is applied once: the withdrawal does not take back a second request", async () => {
	await open();
	h!.state.steps.push(
		choice({ choice: "none" }),
		remember("鍵は靴箱の上", "home.key"),
		remember("傘は玄関", "home.umbrella"),
		memoryCall({ kind: "withdraw", what: "傘" }),
		memoryCall({ kind: "withdraw", what: "傘" }),
		{ text: "取り消しました。" },
	);
	await h!.say("覚えといて、鍵は靴箱の上と傘は玄関。傘は取り消して");
	expect(toolResult(h!.state.calls.at(-1)!)).toContain('"status":"applied"');
	expect(h!.memory!.list().map((item) => item.text)).toEqual(["鍵は靴箱の上"]);
});

test("another run's change to a shown record writes the answer again; this run's own change does not", async () => {
	await open();
	const { saved } = await shownFact();
	let release!: () => void;
	h!.state.gate = new Promise<void>((resolve) => (release = resolve));
	h!.state.steps.push(...reply("古い答え。"), ...reply("新しい答え。"));
	const run = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "夕食の候補は？",
	});
	await waitFor(() => h!.dialogue.get(run.id)?.status === "running");
	await h!.store.write((db) =>
		h!.memory!.suppressInTransaction(db, {
			conversationId: "main",
			sourceRunId: "another-run",
			target: { itemId: saved.id },
		}),
	);
	release();
	await waitFor(() => h!.dialogue.get(run.id)?.status === "completed");
	expect(h!.dialogue.answerText(run.id)).toBe("新しい答え。");
});

test("the plans and goals fields of `## State` reach the model: a plan resting on a forgotten message is not shown", async () => {
	await open();
	const { first } = await shownFact();
	await h!.store.write((db) =>
		h!.continuity.plans.addInTransaction(db, {
			conversationId: "main",
			kind: "plan",
			text: "水曜に歯医者",
			dueAt: "2026-11-25",
			evidence: { messages: [{ messageId: first.inputMessageId }] },
		}),
	);
	h!.state.steps.push(...reply("はい。"));
	await h!.say("予定は？");
	const state = h!.state.calls
		.at(-1)!
		.messages.flatMap((m) => sectionLines(m.content, "State"))
		.join("\n");
	expect(state).toContain("予定:");
	expect(state).toContain("- p1 水曜に歯医者（2026-11-25）");
});

test("a forget that names no reference is kept by the steward and holds the next generation until the agency settles it", async () => {
	await open();
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "forget", what: "元カノの話は全部" }),
		{ text: "対象を探します。" },
	);
	const first = await h!.say("元カノの話は全部忘れて");
	// Kept for good (a restart does not lose it) under the inbox request's id, and told to the agency.
	expect(h!.state.keptTargets).toEqual([
		expect.objectContaining({
			id: h!.state.targetRequests[0]!.requestId,
			request: expect.objectContaining({ kind: "forget", runId: first.id }),
		}),
	]);
	expect(h!.state.pendingForget).toBe(true);
	// The next utterance does not start while the forget is pending: its prompt would still hold what it excludes.
	h!.state.steps.push(...reply("はい。"));
	const calls = h!.state.calls.length;
	const next = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "夕食は？",
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(h!.dialogue.get(next.id)?.status).toBe("queued");
	expect(h!.state.calls).toHaveLength(calls);
	// The agency settled it (excluded what it found) and says so: the generation goes on, no fixed wait.
	h!.state.pendingForget = false;
	h!.dialogue.targetsSettled("main");
	await waitFor(() => h!.dialogue.get(next.id)?.status === "completed");
	expect(h!.dialogue.answerText(next.id)).toBe("はい。");
});

test("a request the agency could not settle is told once in the next generation's host notice", async () => {
	await open();
	h!.state.unresolved.push({ id: "request:1", what: "元カノの話" });
	h!.state.steps.push(...reply("はい。"), ...reply("はい。"));
	await h!.say("夕食は？");
	const input = (call: number) =>
		JSON.stringify(h!.state.calls[call]!.messages.at(-1));
	expect(input(0)).toContain(
		"「元カノの話」の対象を決められず、何も変えていません。",
	);
	await h!.say("明日は？");
	expect(input(1)).not.toContain("対象を決められず");
});

test("a forget by reference tells the agency what was excluded in the same transaction", async () => {
	const excluded: unknown[] = [];
	h = await setup({
		memory: true,
		conversationAgent: { ...testConversationAgent, handsWork: () => false },
		agency: {
			workChangedInTransaction() {},
			memoryExcludedInTransaction: (_db, input) => {
				excluded.push(input);
			},
		},
	});
	const { saved, first } = await shownFact();
	h!.state.steps.push(
		choice({ choice: "none" }),
		memoryCall({ kind: "forget", what: "辛いもの", ref: "m1" }),
		{ text: "忘れました。" },
	);
	await h!.say("辛いものの話は忘れて");
	expect(excluded).toEqual([
		{
			conversationId: "main",
			itemIds: [saved.id],
			messageIds: [first.inputMessageId],
		},
	]);
});

test("a message is hidden in the conversation it was said in, whoever asked for the forget", async () => {
	await open();
	await h!.conversation.append({
		id: "other-said",
		role: "user",
		conversationId: "other",
		text: "別の会話の発言",
		runId: null,
		createdAt: "2026-11-07T00:00:00Z",
	});
	await h!.store.write((db) =>
		h!.dialogue.hideExcludedInTransaction(db, { messageIds: ["other-said"] }),
	);
	const rows = h!.store.read(
		(db) =>
			db
				.query("SELECT message_id, conversation_id FROM dialogue_forget_hidden")
				.all() as Array<{ message_id: string; conversation_id: string }>,
	);
	expect(rows).toEqual([
		{ message_id: "other-said", conversation_id: "other" },
	]);
});

test("what the memory withholds while a forget is only excluded is left out of the history and the recent conversation", async () => {
	await open();
	const { saved, first } = await shownFact();
	// The memory excluded the record (an agency settled the forget), the dialogue did not hide anything itself.
	await h!.store.write((db) =>
		h!.memory!.excludeForForgetInTransaction(db, {
			conversationId: "main",
			sourceRunId: "agency-run",
			targets: [{ itemId: saved.id }],
		}),
	);
	expect(first.inputMessageId).toBeTruthy();
	h!.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_history", args: { query: "辛い" } }] },
		{ text: "ありません。" },
	);
	const earlier = h!.state.calls.length;
	await h!.say("何を話した？");
	const prompt = JSON.stringify(
		h!.state.calls.slice(earlier).map((call) => call.messages),
	);
	expect(prompt).not.toContain(SPICY);
});

test("a fact asked to be remembered again in other words is the first one: it is applied once", async () => {
	await open();
	h!.state.steps.push(
		choice({ choice: "none" }),
		remember("鍵は靴箱の上", "home.key"),
		remember("鍵は靴箱の上にある", "home.key", "鍵は靴箱の上"),
		{ text: "覚えました。" },
	);
	await h!.say("覚えといて、鍵は靴箱の上");
	expect(h!.memory!.list().map((item) => item.text)).toEqual(["鍵は靴箱の上"]);
	expect(h!.memory!.list(true)).toHaveLength(1);
});
