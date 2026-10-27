import { afterEach, expect, test } from "bun:test";
import { toolFields } from "./tool-text.fixture";
import { waitFor } from "../../../infrastructure/wait-for";
import { IMAGE, setup, type Harness } from "./generation.fixture";
import { saveItem } from "./memory-seed";

/**
 * The work the conversation agent does through its tools (the ContextWindow specification, sections 6.1, 6.7, 9
 * and 14): checking a TODO, the confirmation an approval needs to have been heard, the archive of a reported TODO,
 * the agency's spontaneous utterance and the memory read.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/**
 * The JSON results of the tool messages of the nth model call's own turn (after its last user message), in order:
 * the recent conversation before it keeps earlier turns' searches and hand-overs.
 */
function toolResults(call: number): Array<Record<string, unknown>> {
	const messages = h!.state.calls[call]!.messages;
	const last = messages.map((m) => m.role).lastIndexOf("user");
	return messages
		.slice(last + 1)
		.filter((m) => m.role === "tool")
		.map((m) => toolFields(m.content));
}

/** Marks a run as a voice run (the run's utterance): its speech then waits for the playback's report. */
function markVoice(runId: string, utteranceId: string) {
	return h!.store.write((db) =>
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
	await h.finishImage(waiting.id, { state: "completed", title: "猫" });
	const [todo] = h.todos();
	// The user asks later; the generation checks the TODO before it speaks.
	h.state.steps.push(
		{
			calls: [
				{
					name: "work",
					args: { todo: `t${todo!.ref}`, operation: "check" },
				},
			],
		},
		{ text: "猫の絵ができました。" },
	);
	await h.say("さっきの絵はどうなった？");
	const checked = h.state.calls
		.at(-1)!
		.messages.filter((m) => m.role === "tool")
		.at(-1)!.content;
	// The check reads like the host notice: which work, how it ended, and its result as items.
	expect(checked).toStartWith(
		`- ok: true\nt${todo!.ref}「猫の絵」が終わりました（成功）。`,
	);
	expect(checked).toContain("- title: 猫");
	expect(h.log().some((e) => h!.fields(e).action === "work.check")).toBe(true);
});

test("a check of an unknown TODO is refused with todo_not_found and changes nothing", async () => {
	h = await setup();
	h.state.steps.push(
		{
			calls: [
				{
					name: "work",
					args: { todo: "t99", operation: "check" },
				},
			],
		},
		{ text: "見つかりません。" },
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
	h.state.steps.push(
		{ calls: [{ name: "work", args: { todo: "t1", operation: "cancel" } }] },
		{ text: "確認します。" },
	);
	// The state of the call is fixed when it is made (revision 1). The model call is held, the TODO's revision moves on
	// meanwhile (the owner's report bumps it; the job itself cannot run behind the held generation), and the cancel
	// is then looked at against the revision the model saw.
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	const calls = h.state.calls.length;
	const cancelling = h.say("やっぱり取り消して");
	await waitFor(() => h!.state.calls.length > calls);
	await h.store.write((db) =>
		db
			.query("UPDATE dialogue_work SET revision = revision + 1 WHERE id = ?")
			.run(h!.todos()[0]!.id),
	);
	h.state.gate = null;
	release();
	await cancelling;
	expect(toolResults(h.state.calls.length - 1)[0]).toMatchObject({
		ok: false,
		code: "revision_stale",
		todo: "t1",
		status: "todo",
	});
	// Nothing is executed: the TODO is still open and the run it waits on still waits.
	expect(h.todos()).toMatchObject([{ ref: 1, status: "todo" }]);
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
	h.state.steps.push(
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "approve",
						confirmation: "c1",
						announcement: "差し替えます。",
					},
				},
			],
		},
		{
			text: "まだ確認できていません。",
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
	h.state.steps.push(
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "approve",
						confirmation: "c1",
						announcement: "消します。",
					},
				},
			],
		},
		{
			text: "もう一度確認します。",
		},
	);
	await h.say("はい");
	expect(toolResults(h.state.calls.length - 1)[0]).toEqual({
		delegated: false,
		code: "confirmation_not_heard",
	});
	expect(h.todos()).toEqual([]);
});

/** A done image TODO: the delegating run is over (no generation for the result), the TODO waits to be reported. */
async function doneTodo(request: string) {
	h!.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request,
						impact: "create",
						announcement: "描きますね。",
					},
				},
			],
		},
	);
	const waiting = await h!.say(request + "を描いて", "queued");
	await h!.finishImage(waiting.id, { state: "completed", title: request });
	return h!.todos().find((todo) => todo.title === request)!;
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
	h.state.steps.push({ text: "猫の絵ができました。" });
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

test("a text report waits for actual speech completion before archiving its TODO", async () => {
	h = await setup();
	const todo = await doneTodo("猫の絵");
	h.state.steps.push({ text: "猫の絵ができました。" });
	const reply = await h.say("どうなった？");
	await h.store.write((db) =>
		h!.dialogue.archiveReportedInTransaction(db, {
			conversationId: "main",
			messageId: reply.answerMessageId!,
			todoIds: [todo.id],
		}),
	);
	expect(h.todos()).toMatchObject([{ id: todo.id, status: "done" }]);
	await h.store.write((db) =>
		h!.dialogue.recordMessageHeardInTransaction(db, {
			messageId: reply.answerMessageId!,
			playbackId: "replay-full",
			heard: "full",
			text: "猫の絵ができました。",
		}),
	);
	expect(h.todos()).toEqual([]);
	// The result stays in the log as its own line; archiving only takes the TODO out of the state.
	expect(h.results()).toHaveLength(1);
	expect(
		h.log().filter((e) => h!.fields(e).action === "work.archived"),
	).toHaveLength(1);
});

test("a reported TODO whose reply is still being played requests the archive, and the delivery confirms it only when heard in full", async () => {
	h = await setup();
	const full = await doneTodo("猫の絵");
	h.state.steps.push({ text: "猫の絵ができました。" });
	const spoken = await speakVoice("どうなった？", "voice-full");
	const report = (messageId: string, todoIds: string[]) =>
		h!.store.write((db) =>
			h!.dialogue.archiveReportedInTransaction(db, {
				conversationId: "main",
				messageId,
				todoIds,
			}),
		);
	// Not heard yet: nothing is archived, the request is kept for the delivery.
	await report(spoken.answerMessageId!, [full.id]);
	expect(h.todos()).toMatchObject([{ id: full.id, status: "done" }]);
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, spoken.id, "full"),
	);
	expect(h.todos()).toEqual([]);
	expect(
		h.log().find((e) => h!.fields(e).action === "work.archived"),
	).toBeDefined();

	// Heard only in part: the TODO stays done and the log says why; it is reported again on a later opportunity.
	const partial = await doneTodo("犬の絵");
	h.state.steps.push({ text: "犬の絵ができました。" });
	const cut = await speakVoice("犬の絵は？", "voice-cut");
	await report(cut.answerMessageId!, [partial.id]);
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, cut.id, "partial", "犬の"),
	);
	expect(h.todos()).toMatchObject([{ id: partial.id, status: "done" }]);
	expect(
		h.log().find((e) => h!.fields(e).action === "work.archive_unconfirmed"),
	).toMatchObject({ type: "acted", by: "host" });
	// Both reports are log lines; the partially heard one stays in the state, done and unarchived.
	expect(h.results()).toHaveLength(2);
});

test("a TODO that is not done, or belongs to no reply of the conversation, is never archived by a report", async () => {
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
						request: "鳥の絵",
						impact: "create",
						announcement: "描きます。",
					},
				},
			],
		},
	);
	await h.say("鳥の絵を描いて", "queued");
	const [open] = h.todos();
	h.state.steps.push({ text: "まだです。" });
	const reply = await h.say("できた？");
	await h.store.write((db) => {
		h!.dialogue.archiveReportedInTransaction(db, {
			conversationId: "main",
			messageId: reply.answerMessageId!,
			todoIds: [open!.id],
		});
		h!.dialogue.archiveReportedInTransaction(db, {
			conversationId: "main",
			messageId: "no-such-message",
			todoIds: [open!.id],
		});
	});
	expect(h.todos()).toMatchObject([{ id: open!.id, status: "todo" }]);
});

test("an agency utterance is recorded as a spontaneous said event, and the next input carries it as the agent's", async () => {
	h = await setup();
	h.state.steps.push({ text: "はい。" });
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
	expect(h.state.calls[0]!.messages[2]).toEqual({
		role: "assistant",
		content: "そういえば、紅葉の見頃みたいですよ。",
	});
});

test("a spontaneous report keeps its completed TODO until its speech is heard in full", async () => {
	h = await setup();
	const done = await doneTodo("猫の絵");
	h.state.steps.push(
		{ calls: [{ name: "find_toolchain", args: { query: "絵" } }] },
		{
			calls: [
				{
					name: "delegate",
					args: {
						mode: "execute",
						toolchain: IMAGE.id,
						request: "鳥の絵",
						impact: "create",
						announcement: "描きます。",
					},
				},
			],
		},
	);
	await h.say("鳥の絵を描いて", "queued");
	const open = h.todos().find((todo) => todo.title === "鳥の絵")!;
	await h.store.write((db) => {
		h!.conversation.appendInTransaction(db, {
			id: "spontaneous-todo",
			conversationId: "main",
			role: "assistant",
			text: "猫の絵ができましたよ。",
			createdAt: new Date().toISOString(),
			runId: null,
		});
		h!.dialogue.recordSpontaneousInTransaction(db, {
			conversationId: "main",
			messageId: "spontaneous-todo",
			text: "猫の絵ができましたよ。",
			at: new Date().toISOString(),
			todoRefs: [done.id, open.id],
		});
	});
	expect(h.todos()).toHaveLength(2);
	await h.store.write((db) =>
		h!.dialogue.recordMessageHeardInTransaction(db, {
			messageId: "spontaneous-todo",
			playbackId: "spontaneous-full",
			heard: "full",
			text: "猫の絵ができましたよ。",
		}),
	);
	// The reported one is archived; the one still being worked on stays.
	expect(h.todos()).toMatchObject([{ id: open.id, status: "todo" }]);
	const said = h.log().find((e) => h!.fields(e).origin === "spontaneous")!;
	expect(h.fields(said)).toMatchObject({ todoRefs: [done.id, open.id] });
	expect(
		h.log().filter((e) => h!.fields(e).action === "work.archived"),
	).toMatchObject([{ type: "acted", by: "host" }]);
});

test("a memory read returns the long-term items that match, and logs the read", async () => {
	h = await setup({ memory: true });
	h.state.steps.push({ text: "はい。" });
	const first = await h.say("私は辛いものが好きです", "completed");
	h.state.steps.push(
		{ calls: [{ name: "memory", args: { operation: "read", query: "辛い" } }] },
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
	const read = last.messages.filter((m) => m.role === "tool")[0]!.content;
	// The item is already in `## Memory`: the read says so beside its text.
	expect(read).toStartWith(`- ${saved.text}（本人の発言`);
	expect(read).toContain("「## Memory」にある");
	expect(
		last.messages.some(
			(m) =>
				m.content.includes("## Memory\n") &&
				m.content.includes(`- ${saved.text}`),
		),
	).toBe(true);
	expect(
		h.log().find((e) => h!.fields(e).action === "memory.read"),
	).toBeDefined();
});

test("a memory not yet published is read with its text and not marked as shown", async () => {
	h = await setup({ memory: true });
	h.state.steps.push({ text: "はい。" });
	const first = await h.say("私は辛いものが好きです", "completed");
	h.state.steps.push(
		{ calls: [{ name: "memory", args: { operation: "read", query: "辛い" } }] },
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
	const read = h.state.calls
		.at(-1)!
		.messages.filter((m) => m.role === "tool")[0]!.content;
	expect(read).toStartWith("- 辛いものが好き（本人の発言");
	expect(read).not.toContain("「## Memory」にある");
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
					args: { todo: `t${todo!.ref}`, operation: "cancel" },
				},
			],
		},
		{ text: "取り消しました。" },
	);
	const cancelling = await h.say("やっぱりやめて");
	expect(h.dialogue.answerText(cancelling.id)).toBe("取り消しました。");
	expect(toolResults(h.state.calls.length - 1)[0]).toMatchObject({
		ok: true,
		todo: `t${todo!.ref}`,
		status: "done",
		outcome: "cancelled",
	});
	expect(h.dialogue.get(waiting.id)?.status).toBe("cancelled");
	// Cancelled work is not reported back: the TODO is archived at once.
	expect(h.todos()).toEqual([]);
});

test("the TODO screen's page shows the whole request, newest request first, and the archive apart", async () => {
	h = await setup();
	const long = `${"とても長い依頼の説明".repeat(8)}の絵`;
	await doneTodo("猫の絵");
	await doneTodo(long);
	const page = (state: "active" | "archived") =>
		h!.store.read((db) =>
			h!.dialogue.todoPageInTransaction(db, "main", {
				state,
				pageIndex: 0,
				pageSize: 10,
			}),
		);
	const active = page("active");
	expect(active.total).toBe(2);
	expect(active.counts).toEqual({ todo: 0, done: 2, archived: 0 });
	// The ledger's title is cut for the model's state; the screen reads the request itself.
	expect(active.rows.map((row) => row.request)).toEqual([long, "猫の絵"]);
	expect(active.rows[0]!.title.length).toBeLessThan(long.length);
	expect(page("archived").rows).toEqual([]);
});

test("a reported TODO can still be checked: its report is read again, with room for what the notice left out", async () => {
	h = await setup();
	const todo = await doneTodo("猫の絵");
	// Reported and heard: the TODO is archived.
	await h.store.write((db) =>
		db
			.query("UPDATE dialogue_work SET archived_at = ? WHERE id = ?")
			.run(new Date().toISOString(), todo.id),
	);
	expect(h.todos()).toEqual([]);
	h.state.steps.push(
		{
			calls: [
				{ name: "work", args: { todo: `t${todo.ref}`, operation: "check" } },
			],
		},
		{ text: "猫の絵でした。" },
	);
	await h.say("さっきの絵、もう一度教えて");
	const checked = h.state.calls
		.at(-1)!
		.messages.filter((m) => m.role === "tool")
		.at(-1)!.content;
	expect(checked).toStartWith(
		`- ok: true\nt${todo.ref}「猫の絵」が終わりました`,
	);
	// The state names it as reported, so the model knows the number to read.
	const last = h.state.calls
		.at(-1)!
		.messages.filter((m) => m.role === "user")
		.at(-1)!.content;
	expect(last).toContain(`- t${todo.ref} 猫の絵 報告済み`);
});

test("a spoken reply takes its place when adopted and keeps only what was heard; one not heard at all leaves the input", async () => {
	h = await setup();
	h.state.steps.push({ text: "猫の絵ができました。" });
	const cut = await speakVoice("絵はできた？", "voice-cut");
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, cut.id, "partial", "猫の絵ができ"),
	);
	h.state.steps.push({ text: "はい。" });
	const lost = await speakVoice("本当？", "voice-lost");
	await h.store.write((db) =>
		h!.dialogue.recordHeardInTransaction(db, lost.id, "none"),
	);
	h.state.steps.push({ text: "どうぞ。" });
	await h.say("次は？");
	const messages = h.state.calls.at(-1)!.messages;
	// The reply cut short is what was heard; the one not heard is gone, so the user's words before it join the last.
	expect(messages.slice(2, -1).map((m) => m.content)).toEqual(["猫の絵ができ"]);
	expect(messages.at(-1)!.content).toStartWith("本当？\n\n## State\n");
});
