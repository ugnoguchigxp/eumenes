import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { IMAGE, respond, setup, type Harness } from "./generation.fixture";
import { saveItem } from "./memory-seed";

/**
 * The work the conversation agent does through its tools (the ContextWindow specification, sections 6.1, 6.7, 9
 * and 14): checking a TODO, the confirmation an approval needs to have been heard, the delivery of a told archive,
 * the agency's spontaneous utterance and the memory read.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const chat = respond();

/** The JSON results of the tool messages the nth model call received, in order. */
function toolResults(call: number): Array<Record<string, unknown>> {
	return h!.state.calls[call]!.messages.filter((m) => m.role === "tool").map(
		(m) => JSON.parse(m.content) as Record<string, unknown>,
	);
}

/** Marks a run as a voice run (the run's utterance): its speech then waits for the playback's report. */
function markVoice(runId: string, utteranceId: string) {
	h!.store.write((db) =>
		db
			.query("UPDATE dialogue_runs SET utterance_id = ? WHERE id = ?")
			.run(utteranceId, runId),
	);
}

test("check reads a TODO's state and result into the tool result, and logs only the check", async () => {
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
						request: "猫の絵",
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	const [todo] = h.todos();
	// The image finishes; the resumed generation checks the TODO before it speaks.
	h.state.steps.push(
		{
			calls: [
				{
					name: "work",
					args: {
						todo: todo!.id,
						operation: "check",
						revision: todo!.revision,
					},
				},
			],
		},
		{ text: "猫の絵ができました。", calls: [chat] },
	);
	await h.finishImage(waiting.id, { state: "completed", title: "猫" });
	const checked = toolResults(h.state.calls.length - 1).at(-1);
	expect(checked).toMatchObject({
		ok: true,
		todo: { id: todo!.id, status: "done", outcome: "succeeded" },
	});
	expect(checked).toHaveProperty("result");
	expect(h.log().some((e) => h!.fields(e).action === "work.check")).toBe(true);
});

test("a check of an unknown TODO is refused with todo_not_found and changes nothing", async () => {
	h = await setup();
	h.state.steps.push(
		{
			calls: [
				{
					name: "work",
					args: {
						todo: "00000000-0000-4000-8000-000000000000",
						operation: "check",
						revision: 0,
					},
				},
			],
		},
		{ text: "見つかりません。", calls: [chat] },
	);
	const run = await h.say("さっきの仕事を見て");
	expect(run.status).toBe("completed");
	expect(toolResults(1)[0]).toEqual({ ok: false, code: "todo_not_found" });
	expect(
		h.log().some((e) => h!.fields(e).action?.toString().startsWith("work.")),
	).toBe(false);
});

test("a stale revision is refused with revision_stale and the current state, nothing is executed", async () => {
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
						request: "猫の絵",
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	const [todo] = h.todos();
	h.state.steps.push(
		{
			calls: [
				{
					name: "work",
					args: {
						todo: todo!.id,
						operation: "cancel",
						revision: todo!.revision + 5,
					},
				},
			],
		},
		{ text: "確認します。", calls: [chat] },
	);
	await h.say("やっぱり取り消して");
	expect(toolResults(h.state.calls.length - 1)[0]).toMatchObject({
		ok: false,
		code: "revision_stale",
	});
	expect(h.dialogue.get(waiting.id)?.status).toBe("queued");
});

test("an approval is refused when the confirmation statement was not heard at all", async () => {
	h = await setup({ autoStart: false });
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵の差替え" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "confirm",
						toolchain: IMAGE.id,
						request: "壁紙を差し替える",
						impact: "modify_existing",
						announcement: "差し替えてよいですか？",
					},
				},
			],
		},
		{
			text: "差し替えてよいですか？",
			calls: [respond({ kind: "action", impact: "modify_existing" })],
		},
	);
	// The statement is spoken, so its delivery waits for the playback.
	const confirmRun = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "壁紙を差し替えて",
	});
	markVoice(confirmRun.id, "voice-confirm");
	h.start();
	await waitFor(() => h!.dialogue.get(confirmRun.id)?.status === "completed");
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, confirmRun.id, "none"),
	);
	const confirmationId = h.store.read(
		(db) =>
			(
				db.query("SELECT id FROM dialogue_confirmations").get() as {
					id: string;
				}
			).id,
	);
	h.state.steps.push(
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "approve",
						confirmation: confirmationId,
						announcement: "差し替えます。",
					},
				},
			],
		},
		{
			text: "まだ確認できていません。",
			calls: [
				respond({
					kind: "action",
					impact: "modify_existing",
					approved: true,
					unavailable: true,
				}),
			],
		},
	);
	const approval = await h.say("お願い", "completed");
	expect(h.dialogue.answerText(approval.id)).toBe("まだ確認できていません。");
	expect(toolResults(h.state.calls.length - 1)[0]).toEqual({
		delegated: false,
		code: "confirmation_not_heard",
	});
	expect(h.todos()).toEqual([]);
});

test("an irreversible confirmation heard only in part is not enough to approve", async () => {
	h = await setup({ autoStart: false });
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "削除" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "confirm",
						toolchain: IMAGE.id,
						request: "絵を削除する",
						impact: "irreversible",
						announcement: "削除してよいですか？",
					},
				},
			],
		},
		{
			text: "削除してよいですか？",
			calls: [respond({ kind: "action", impact: "irreversible" })],
		},
	);
	const confirmRun = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "絵を消して",
	});
	markVoice(confirmRun.id, "voice-irreversible");
	h.start();
	await waitFor(() => h!.dialogue.get(confirmRun.id)?.status === "completed");
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(
			db,
			confirmRun.id,
			"partial",
			"削除して",
		),
	);
	const confirmationId = h.store.read(
		(db) =>
			(
				db.query("SELECT id FROM dialogue_confirmations").get() as {
					id: string;
				}
			).id,
	);
	h.state.steps.push(
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "approve",
						confirmation: confirmationId,
						announcement: "消します。",
					},
				},
			],
		},
		{
			text: "もう一度確認します。",
			calls: [
				respond({
					kind: "action",
					impact: "irreversible",
					approved: true,
					unavailable: true,
				}),
			],
		},
	);
	await h.say("はい");
	expect(toolResults(h.state.calls.length - 1)[0]).toEqual({
		delegated: false,
		code: "confirmation_not_heard",
	});
	expect(h.todos()).toEqual([]);
});

test("a partial playback keeps what was heard without the announcement, and a told archive stays unconfirmed", async () => {
	h = await setup({ autoStart: false });
	h.dialogue.setAnnouncementDelivery(async () => "full" as const);
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "猫の絵",
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "猫の絵を描いて",
	});
	markVoice(waiting.id, "voice-partial");
	h.start();
	// The delegation committed: the TODO exists and the run waits for its work.
	await waitFor(
		() =>
			h!.todos().length === 1 &&
			h!.dialogue.get(waiting.id)?.status === "queued",
	);
	const [todo] = h.todos();
	// The result comes back; the answer tells the TODO's archive, names it, and is spoken.
	h.state.steps.push(
		{
			calls: [
				{
					name: "work",
					args: {
						todo: todo!.id,
						operation: "archive",
						revision: todo!.revision + 1,
						told: "this",
					},
				},
			],
		},
		{
			text: "猫の絵ができました。",
			calls: [respond({ todoRefs: [todo!.id] })],
		},
	);
	await h.finishImage(waiting.id, { state: "completed", title: "猫" });
	await waitFor(() => h!.dialogue.get(waiting.id)?.status === "completed");
	const answered = h.dialogue.get(waiting.id)!;
	expect(h.dialogue.answerText(answered.id)).toBe("猫の絵ができました。");
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(
			db,
			answered.id,
			"partial",
			"描きますね。猫の絵ができました。",
		),
	);
	const heard = h
		.log()
		.find((e) => e.type === "delivered" && h!.fields(e).heard === "partial");
	expect(h.fields(heard!)).toMatchObject({
		heard: "partial",
		deliveredText: "猫の絵ができました。",
	});
	expect(
		h.log().find((e) => h!.fields(e).action === "work.archive_unconfirmed"),
	).toBeDefined();
	expect(h.todos()).toMatchObject([{ id: todo!.id, status: "done" }]);
	expect(h.active()).toHaveLength(1);
});

test("an agency utterance is recorded as a spontaneous said event, and the next document carries it", async () => {
	h = await setup();
	h.state.steps.push({ text: "はい。", calls: [chat] });
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
	const document = JSON.parse(h.state.calls[0]!.messages[1]!.content) as {
		log: Array<{ text?: string; origin?: string }>;
	};
	expect(
		document.log.some(
			(e) =>
				e.text === "そういえば、紅葉の見頃みたいですよ。" &&
				e.origin === "spontaneous",
		),
	).toBe(true);
});

test("a memory read returns the long-term items that match, and logs the read", async () => {
	h = await setup({ memory: true });
	h.state.steps.push({ text: "はい。", calls: [chat] });
	const first = await h.say("私は辛いものが好きです", "completed");
	h.state.steps.push(
		{ calls: [{ name: "memory", args: { operation: "read", query: "辛い" } }] },
		{ text: "辛いものがお好きですね。", calls: [chat] },
	);
	const saved = await saveItem(h.store, h.memory!, {
		conversationId: "main",
		messageId: first.inputMessageId,
		quote: "辛いものが好き",
		kind: "preference",
		semanticKey: "food.spicy",
		text: "辛いものが好き",
	});
	await h.say("私の好みは？");
	const read = toolResults(h.state.calls.length - 1)[0] as {
		items: Array<{ id: string; inProfile: boolean; text?: string }>;
	};
	// The item is already in the profile the window shows, so the read names it without repeating its text (section 14).
	expect(read.items).toEqual([{ id: saved.id, inProfile: true }]);
	expect(
		h.log().find((e) => h!.fields(e).action === "memory.read"),
	).toBeDefined();
});

test("cancel of a waiting TODO from a later utterance ends the run it waits on, and the TODO is done as cancelled", async () => {
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
						request: "猫の絵",
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h.say("猫の絵を描いて", "queued");
	const [todo] = h.todos();
	h.state.steps.push(
		{
			calls: [
				{
					name: "work",
					args: {
						todo: todo!.id,
						operation: "cancel",
						revision: todo!.revision,
					},
				},
			],
		},
		{ text: "取り消しました。", calls: [chat] },
	);
	const cancelling = await h.say("やっぱりやめて");
	expect(h.dialogue.answerText(cancelling.id)).toBe("取り消しました。");
	expect(toolResults(h.state.calls.length - 1)[0]).toMatchObject({
		ok: true,
		todo: { id: todo!.id, status: "done", outcome: "cancelled" },
	});
	expect(h.dialogue.get(waiting.id)?.status).toBe("cancelled");
	expect(h.todos()).toMatchObject([
		{ id: todo!.id, status: "done", outcome: "cancelled" },
	]);
});
