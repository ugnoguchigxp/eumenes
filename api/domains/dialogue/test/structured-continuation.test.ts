import { afterEach, expect, test } from "bun:test";
import {
	setup,
	until,
	ADAPTER,
	type Harness,
} from "./command-interactions.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const work = (todo: string, operation: "answer" | "cancel") => ({
	calls: [{ name: "work", args: { todo, operation } }],
});

test("a conversation answer resumes the same question and work once", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const before = h.interaction()!;
	const todoId = h.todos()[0]!.id;
	const beforeAnswer = h.calls.length;
	h.state.steps.push(work("t1", "answer"));
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 15 },
	});
	h.state.outcome = {
		state: "saved",
		adapterRef: ADAPTER,
		operationId: "fixture-op",
		digest: "fixture-digest",
	};
	await h.say("15秒です");
	await until(() => h!.interaction()?.status === "completed");
	expect(h.interaction()!.id).toBe(before.id);
	expect(h.archived().map((todo) => todo.id)).toEqual([todoId]);
	expect(h.started).toHaveLength(1);
	expect(h.calls[beforeAnswer]!.tools).toContain("work");
	expect(h.calls[beforeAnswer]!.messages.at(-1)!.content).toContain("質問待ち");
	expect(JSON.stringify(h.commandPrompts.at(-1))).toContain("15秒です");
});

test("a mixed reply asks about the whole unperformed scope and leaves the existing question open", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const before = h.interaction()!;
	h.state.steps.push({
		text: "タイマーの15秒と天気の調査がまだ実施していない依頼です。天気も調べてよいですか？",
	});
	const run = await h.say("15秒です。天気も調べて");
	expect(h.dialogue.answerText(run.id)).toContain("まだ実施していない依頼");
	expect(h.dialogue.answerText(run.id)).toContain("天気も調べて");
	expect(h.dialogue.answerText(run.id)).not.toContain(
		"S11TNEXT_DELIMITED_CONTEXT",
	);
	expect(h.interaction()).toMatchObject({
		id: before.id,
		status: "waiting_input",
		revision: before.revision,
	});
	expect(h.todos()).toHaveLength(1);
	expect(h.started).toHaveLength(0);
});

test("an invented question reference fails before answering or starting a replacement job", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const before = h.interaction()!;
	h.state.steps.push(work("t9", "answer"), {
		text: "回答はまだ作業に送っていません。",
	});
	const run = await h.say("15秒です");
	expect(h.dialogue.answerText(run.id)).toBe(
		"回答はまだ作業に送っていません。",
	);
	expect(h.interaction()).toMatchObject({
		id: before.id,
		status: "waiting_input",
		revision: before.revision,
	});
	expect(h.todos()).toHaveLength(1);
	expect(h.started).toHaveLength(0);
});

test("structured cancellation reaches the same command and rejects a later answer to its closed question", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const todo = h.todos()[0]!;
	const interaction = h.interaction()!;
	h.state.steps.push(work("t1", "cancel"), { text: "作業を取り消しました。" });
	await h.say("その作業を取り消してください");
	expect(h.todos()).toHaveLength(0);
	expect(h.archived()).toMatchObject([{ id: todo.id, outcome: "cancelled" }]);
	expect(h.interaction()?.status).toBe("cancelled");
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: interaction.revision,
			input: "15秒です",
		}),
	).rejects.toThrow("interaction_closed");
	h.state.steps.push(work("t1", "answer"), {
		text: "回答はまだ作業に送っていません。",
	});
	await h.say("15秒です");
	expect(h.calls.at(-1)!.messages.at(-1)!.content).toContain(
		"work_operation_unavailable",
	);
	expect(h.archived()).toHaveLength(1);
	expect(h.started).toHaveLength(0);
});

test("the first conversation call sees the complete mixed request", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const before = h.interaction()!;
	const text = "15秒です。それとは別に天気を調べてください。";
	h.state.steps.push({ text: "どちらから実行しますか？" });
	await h.say(text);
	expect(h.calls.at(-1)!.messages.at(-1)!.content).toContain(text);
	expect(h.calls.at(-1)!.messages[0]!.content).toContain(
		"独立した実行依頼が混ざる",
	);
	expect(h.interaction()).toMatchObject({
		id: before.id,
		status: "waiting_input",
		revision: before.revision,
	});
	expect(h.started).toHaveLength(0);
});
