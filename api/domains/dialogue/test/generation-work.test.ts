import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { choice, reply, setup, type Harness } from "./generation.fixture";
import { saveItem } from "./memory-seed";

/**
 * What the routed turn does through the host besides handing work over (the ContextWindow specification, sections 8
 * and 14): the playback's report of what was heard, the agency's spontaneous utterance and the memory read.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** Marks a run as a voice run (the run's utterance): its speech then waits for the playback's report. */
function markVoice(runId: string, utteranceId: string) {
	return h!.store.write((db) =>
		db
			.query("UPDATE dialogue_runs SET utterance_id = ? WHERE id = ?")
			.run(utteranceId, runId),
	);
}

/**
 * Submits an utterance as a voice run and waits for its reply (spoken, so its delivery waits for the playback).
 * The model call is held until the run is marked, so the mark is in place when the reply is adopted.
 */
async function speakVoice(text: string, utteranceId: string) {
	let release!: () => void;
	h!.state.gate = new Promise<void>((resolve) => (release = resolve));
	const calls = h!.state.calls.length;
	const accepted = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text,
	});
	await waitFor(() => h!.state.calls.length > calls);
	await markVoice(accepted.id, utteranceId);
	h!.state.gate = null;
	release();
	await waitFor(() => h!.dialogue.get(accepted.id)?.status === "completed");
	return h!.dialogue.get(accepted.id)!;
}

test("a partial playback records what was heard of the reply", async () => {
	h = await setup();
	h.state.steps.push(...reply("猫の絵ができました。"));
	const answered = await speakVoice("絵はできた？", "voice-partial");
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(
			db,
			answered.id,
			"partial",
			"猫の絵ができ",
		),
	);
	const heard = h
		.log()
		.find((e) => e.type === "delivered" && h!.fields(e).heard === "partial");
	expect(h.fields(heard!)).toMatchObject({
		heard: "partial",
		deliveredText: "猫の絵ができ",
	});
});

test("an agency utterance is recorded as a spontaneous said event, and the next input carries it as the agent's", async () => {
	h = await setup();
	h.state.steps.push(...reply("はい。"));
	await h.store.write((db) =>
		h!.dialogue.recordSpontaneousInTransaction(db, {
			conversationId: "main",
			messageId: "spontaneous-1",
			text: "そういえば、紅葉の見頃みたいですよ。",
			at: new Date().toISOString(),
		}),
	);
	await h.say("こんにちは");
	const spontaneous = h
		.log()
		.find((e) => h!.fields(e).origin === "spontaneous");
	expect(spontaneous).toMatchObject({ type: "said", by: "agent" });
	expect(h.fields(spontaneous!)).toMatchObject({
		text: "そういえば、紅葉の見頃みたいですよ。",
	});
	// The next input shows it as the agent's own message of the recent conversation.
	expect(h.state.calls.at(-1)!.messages[2]).toEqual({
		role: "assistant",
		content: "そういえば、紅葉の見頃みたいですよ。",
	});
});

test("a memory read leaves out the items already in `## Memory` and logs the read", async () => {
	h = await setup({ memory: true });
	h.state.steps.push(...reply("はい。"));
	const first = await h.say("私は辛いものが好きです", "completed");
	h.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_memory", args: { query: "辛い" } }] },
		{ text: "辛いものがお好きですね。" },
	);
	const saved = await saveItem(h.store, h.memory!, {
		conversationId: "main",
		messageId: first.inputMessageId,
		quote: "辛いものが好き",
		kind: "preference",
		semanticKey: "food.spicy",
		text: "辛いものが好き",
	});
	// Publishing the profile puts the saved item in `## Memory` (the next input is cut and draws it again).
	await h.store.write((db) =>
		h!.memory!.republishWindowInTransaction(db, "main"),
	);
	await h.say("私の好みは？");
	const last = h.state.calls.at(-1)!;
	const notice = last.messages.find(
		(m) => (m.role as string) === "tool",
	)!.content;
	// The item is already in `## Memory`: the read leaves it out instead of repeating it.
	expect(notice).not.toContain(saved.text);
	expect(
		last.messages.some(
			(m) =>
				m.content.includes("## Memory\n") &&
				m.content.includes(`- m1 ${saved.text}`),
		),
	).toBe(true);
	expect(h.log().find((e) => h!.fields(e).action === "read")).toBeDefined();
});

test("a memory not yet published is read with its text and not marked as shown", async () => {
	h = await setup({ memory: true });
	h.state.steps.push(...reply("はい。"));
	const first = await h.say("私は辛いものが好きです", "completed");
	h.state.steps.push(
		choice({ choice: "none" }),
		{ calls: [{ name: "read_memory", args: { query: "辛い" } }] },
		{ text: "辛いものがお好きですね。" },
	);
	await saveItem(h.store, h.memory!, {
		conversationId: "main",
		messageId: first.inputMessageId,
		quote: "辛いものが好き",
		kind: "preference",
		semanticKey: "food.spicy",
		text: "辛いものが好き",
	});
	// Not published yet: `## Memory` does not show it, so the read gives it whole and unmarked.
	await h.say("私の好みは？");
	const notice = h.state.calls
		.at(-1)!
		.messages.find((m) => (m.role as string) === "tool")!.content;
	expect(notice).toContain("- m1 辛いものが好き（本人の発言");
	expect(notice).not.toContain("「## Memory」にある");
});

test("a spoken reply takes its place when adopted and keeps only what was heard; one not heard at all leaves the input", async () => {
	h = await setup();
	h.state.steps.push(...reply("猫の絵ができました。"));
	const cut = await speakVoice("絵はできた？", "voice-cut");
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, cut.id, "partial", "猫の絵ができ"),
	);
	h.state.steps.push(...reply("はい。"));
	const lost = await speakVoice("本当？", "voice-lost");
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, lost.id, "none"),
	);
	h.state.steps.push(...reply("どうぞ。"));
	await h.say("次は？");
	const messages = h.state.calls.at(-1)!.messages;
	// The reply cut short is what was heard; the one not heard is gone, so the user's words before it join the last.
	expect(messages.slice(2, -1).map((m) => m.content)).toEqual(["猫の絵ができ"]);
	expect(messages.at(-1)!.content).toStartWith("本当？\n\n## State\n");
});
