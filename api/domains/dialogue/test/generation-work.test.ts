import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerDialogue } from "..";
import { toolFields } from "./tool-text.fixture";
import { waitFor } from "../../../infrastructure/wait-for";
import { IMAGE, setup, type Harness } from "./generation.fixture";
import { saveItem } from "./memory-seed";

/**
 * The work the conversation agent does through its tools (the ContextWindow specification, sections 6.1, 6.7, 9
 * and 14): checking a TODO, the confirmation an approval needs to have been heard, the archive of finished work with
 * its notice, the agency's spontaneous utterance and the memory read.
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
	const [todo] = h.archived();
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

/** A done image TODO: the delegating run is over (no generation for the result), the TODO archived with its notice. */
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
	return h!.archived().find((todo) => todo.title === request)!;
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

test("finished work is archived as it finishes, with an unread notice the screen reads and marks read", async () => {
	h = await setup();
	const todo = await doneTodo("猫の絵");
	expect(h.todos()).toEqual([]);
	expect(todo).toMatchObject({ status: "done", outcome: "succeeded" });
	expect(todo.archivedAt).not.toBeNull();
	// The result stays in the log as its own line; nothing waits for the conversation to tell it.
	expect(h.results()).toHaveLength(1);
	const { notices, unread } = h.notices();
	expect(unread).toBe(1);
	expect(notices).toMatchObject([
		{
			id: todo.id,
			conversationId: "main",
			title: "猫の絵",
			outcome: "succeeded",
			read: false,
		},
	]);
	expect(await h.dialogue.readTodoNotice(todo.id)).toBe(true);
	expect(h.notices()).toMatchObject({ unread: 0, notices: [{ read: true }] });
	// The image toolchain has no registered screen: the notice launches what it made instead.
	expect(h.notices().notices[0]).not.toHaveProperty("artifactId");
	// Reading again changes nothing; a TODO with no notice is not found.
	expect(await h.dialogue.readTodoNotice(todo.id)).toBe(true);
	expect(await h.dialogue.readTodoNotice("no-such-todo")).toBe(false);
});

test("clearing notification history keeps TODO results, archives every page, and leaves future completion notices visible", async () => {
	h = await setup();
	const old = await doneTodo("山の絵");
	await doneTodo("海の絵");
	await h.dialogue.readTodoNotice(old.id);
	expect(h.dialogue.todoNotices(1).notices).toHaveLength(1);
	const work = h.archived();
	const results = h.results();
	const app = new Hono();
	registerDialogue(app, h.dialogue);
	for (let i = 0; i < 2; i++) {
		expect(
			(await app.request("/api/todo-notices/archive", { method: "POST" }))
				.status,
		).toBe(204);
		expect(await (await app.request("/api/todo-notices")).json()).toEqual({
			notices: [],
			unread: 0,
		});
		expect(h.archived()).toEqual(work);
		expect(h.results()).toEqual(results);
	}
	await doneTodo("森の絵");
	expect(h.notices()).toMatchObject({
		unread: 1,
		notices: [{ title: "森の絵", read: false }],
	});
	expect(h.archived()).toHaveLength(3);
});

test("the TODO screen's archive stops the run an open TODO waits on and archives it as cancelled, with no notice", async () => {
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
	const waiting = await h.say("鳥の絵を描いて", "queued");
	const [open] = h.todos();
	const { row, jobs } = await h.store.write((db) =>
		h!.dialogue.archiveTodoInTransaction(db, open!.id),
	);
	h.dialogue.flushTodoCancellations(jobs);
	expect(row).toMatchObject({ status: "done", outcome: "cancelled" });
	expect(row.archivedAt).not.toBeNull();
	expect(h.dialogue.get(waiting.id)?.status).toBe("cancelled");
	expect(h.todos()).toEqual([]);
	expect(h.notices()).toEqual({ notices: [], unread: 0 });
	// Archived already: the screen's second press changes nothing.
	const again = await h.store.write((db) =>
		h!.dialogue.archiveTodoInTransaction(db, open!.id),
	);
	expect(again).toEqual({ row, jobs: [] });
	await expect(
		h.store.write((db) =>
			h!.dialogue.archiveTodoInTransaction(db, "no-such-todo"),
		),
	).rejects.toThrow("work_not_found");
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

test("the TODO screen's page shows the whole request, the newest finished first, in the archive", async () => {
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
	const archived = page("archived");
	expect(archived.total).toBe(2);
	expect(archived.counts).toEqual({ todo: 0, archived: 2 });
	// The ledger's title is cut for the model's state; the screen reads the request itself.
	expect(archived.rows.map((row) => row.request)).toEqual([long, "猫の絵"]);
	expect(archived.rows[0]!.title.length).toBeLessThan(long.length);
	expect(page("active").rows).toEqual([]);
});

test("a finished TODO can still be checked: its result is read again, with room for what the notice left out", async () => {
	h = await setup();
	const todo = await doneTodo("猫の絵");
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
	// The state names it as notified, so the model knows the number to read.
	const last = h.state.calls
		.at(-1)!
		.messages.filter((m) => m.role === "user")
		.at(-1)!.content;
	expect(last).toContain(`- t${todo.ref} 猫の絵 通知済み`);
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
