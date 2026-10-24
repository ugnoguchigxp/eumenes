import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { IMAGE, respond, setup, type Harness } from "./generation.fixture";

/**
 * The latest utterance stopped, corrected and answered again (the prompt edit design, sections 3 and 4): only
 * while no action was committed from it and no answer was adopted, in one writer transaction.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const chat = respond();
const submit = (text: string, extra: { presentation?: "artifact" } = {}) =>
	h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text,
		...extra,
	});
const resubmit = (
	messageId: string,
	text: string,
	requestId = crypto.randomUUID(),
) => h!.dialogue.resubmit("main", messageId, { requestId, text });
const pending = () =>
	h!.store.read((db) => h!.continuity.events.pendingInTransaction(db, "main"));
const runCount = () => h!.dialogue.list("main").length;

test("an edit while the answer is generated stops the run, corrects the utterance and answers it again", async () => {
	h = await setup();
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "犬です。", calls: [chat] });
	const first = await submit("犬の絵を描いて");
	await waitFor(() => h!.state.calls.length === 1);
	const result = await resubmit(first.inputMessageId, "猫の絵を描いて");
	if (!result.ok) throw new Error(result.code);
	expect(h.dialogue.get(first.id)).toMatchObject({
		status: "cancelled",
		error: "edited",
	});
	expect(result.run).toMatchObject({
		status: "queued",
		inputMessageId: first.inputMessageId,
		sourceKind: "manual",
	});
	expect(h.conversation.message(first.inputMessageId)?.text).toBe(
		"猫の絵を描いて",
	);
	// The log's pending copy is the corrected one: the next generation reads what the user meant.
	expect(pending().map((e) => h!.fields(e).text)).toEqual(["猫の絵を描いて"]);
	h.state.steps.push({ text: "猫です。", calls: [chat] });
	release();
	await waitFor(() => h!.dialogue.get(result.run.id)?.status === "completed");
	expect(h.dialogue.answerText(result.run.id)).toBe("猫です。");
	expect(h.state.calls.at(-1)!.messages.at(-1)!.content).toContain(
		"猫の絵を描いて",
	);
	// The stopped generation's answer was never adopted.
	expect(h.dialogue.get(first.id)?.answerMessageId).toBeNull();
	expect(
		h.conversation
			.get("main")
			.messages.filter((m) => m.role === "assistant")
			.map((m) => m.text),
	).toEqual(["猫です。"]);
});

test("the same text sends the utterance again without a correction", async () => {
	h = await setup({ autoStart: false });
	const first = await submit("天気は？");
	const result = await resubmit(first.inputMessageId, "天気は？");
	if (!result.ok) throw new Error(result.code);
	expect(h.dialogue.get(first.id)?.status).toBe("cancelled");
	expect(
		h.store.read((db) =>
			db
				.query(
					"SELECT COUNT(*) AS n FROM conversation_outbox WHERE kind = 'corrected'",
				)
				.get(),
		),
	).toEqual({ n: 0 });
	h.state.steps.push({ text: "晴れです。", calls: [chat] });
	h.start();
	await waitFor(() => h!.dialogue.get(result.run.id)?.status === "completed");
});

test("an utterance stopped by the user can be edited and answered", async () => {
	h = await setup({ autoStart: false });
	const first = await submit("A");
	await h.dialogue.cancel(first.id);
	const result = await resubmit(first.inputMessageId, "B");
	if (!result.ok) throw new Error(result.code);
	expect(h.dialogue.get(first.id)?.error).toBe("cancel_requested");
	h.state.steps.push({ text: "Bです。", calls: [chat] });
	h.start();
	await waitFor(() => h!.dialogue.get(result.run.id)?.status === "completed");
	expect(h.state.calls.at(-1)!.messages.at(-1)!.content).toContain("B");
});

test("an answered utterance is not edited, and nothing changes", async () => {
	h = await setup();
	h.state.steps.push({ text: "こんにちは。", calls: [chat] });
	const done = await h.say("やあ");
	const before = runCount();
	expect(await resubmit(done.inputMessageId, "おはよう")).toEqual({
		ok: false,
		code: "already_acted",
	});
	expect(runCount()).toBe(before);
	expect(h.conversation.message(done.inputMessageId)?.text).toBe("やあ");
});

test("an utterance whose delegation was committed is refused and its run keeps waiting", async () => {
	h = await setup();
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "犬の絵",
						impact: "create",
						announcement: "描きます。",
					},
				},
			],
		},
	);
	const waiting = await h.say("犬の絵", "queued");
	expect(await resubmit(waiting.inputMessageId, "猫の絵")).toEqual({
		ok: false,
		code: "already_acted",
	});
	expect(h.dialogue.get(waiting.id)?.status).toBe("queued");
	expect(h.conversation.message(waiting.inputMessageId)?.text).toBe("犬の絵");
});

test("an utterance followed by another is not the latest", async () => {
	h = await setup({ autoStart: false });
	const first = await submit("A");
	await submit("B");
	expect(await resubmit(first.inputMessageId, "C")).toEqual({
		ok: false,
		code: "not_latest",
	});
});

test("a screen's submit, an empty text and another conversation's message are refused", async () => {
	h = await setup({ autoStart: false });
	const screen = await submit("フォーム", { presentation: "artifact" });
	expect(await resubmit(screen.inputMessageId, "直す")).toEqual({
		ok: false,
		code: "not_editable",
	});
	const typed = await submit("A");
	expect(await resubmit(typed.inputMessageId, "")).toEqual({
		ok: false,
		code: "empty_text",
	});
	expect(
		await h.dialogue.resubmit("other", typed.inputMessageId, {
			requestId: crypto.randomUUID(),
			text: "B",
		}),
	).toEqual({ ok: false, code: "not_found" });
});

test("a repeated requestId is one edit and one run", async () => {
	h = await setup({ autoStart: false });
	const first = await submit("A");
	const requestId = crypto.randomUUID();
	const once = await resubmit(first.inputMessageId, "B", requestId);
	const again = await resubmit(first.inputMessageId, "B", requestId);
	if (!once.ok || !again.ok) throw new Error("refused");
	expect(again.run.id).toBe(once.run.id);
	expect(runCount()).toBe(2);
	// Editing it once more stops the edited run in turn.
	const twice = await resubmit(first.inputMessageId, "C");
	if (!twice.ok) throw new Error(twice.code);
	expect(h.dialogue.get(once.run.id)).toMatchObject({
		status: "cancelled",
		error: "edited",
	});
});

test("finding a toolchain commits nothing: the utterance is still edited, and its exchange moves to the new run", async () => {
	h = await setup();
	let first!: () => void;
	let second!: () => void;
	h.state.gate = new Promise<void>((resolve) => (first = resolve));
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		{ text: "描きます。", calls: [chat] },
	);
	const run = await submit("犬の絵");
	await waitFor(() => h!.state.calls.length === 1);
	h.state.gate = new Promise<void>((resolve) => (second = resolve));
	first();
	await waitFor(() => h!.state.calls.length === 2);
	const result = await resubmit(run.inputMessageId, "猫の絵");
	if (!result.ok) throw new Error(result.code);
	expect(h.conversation.message(run.inputMessageId)?.runId).toBe(result.run.id);
	h.state.steps.push({ text: "猫です。", calls: [chat] });
	second();
	await waitFor(() => h!.dialogue.get(result.run.id)?.status === "completed");
	expect(
		h.conversation
			.get("main")
			.messages.filter((m) => m.runId === result.run.id)
			.map((m) => m.role),
	).toEqual(["user", "assistant"]);
});

test("a repeated requestId with another text is a conflict", async () => {
	h = await setup({ autoStart: false });
	const first = await submit("A");
	const requestId = crypto.randomUUID();
	await resubmit(first.inputMessageId, "B", requestId);
	await expect(resubmit(first.inputMessageId, "C", requestId)).rejects.toThrow(
		"request_conflict",
	);
});
