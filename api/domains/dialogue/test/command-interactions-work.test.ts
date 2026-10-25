import { afterEach, expect, test } from "bun:test";
import {
	ADAPTER,
	setup,
	until,
	type Harness,
} from "./command-interactions.fixture";

/**
 * A command toolchain's question is answered by the conversation's `work` tool (operation `answer`) or by the
 * UI through the interaction routes (the ContextWindow specification, sections 6.1 and 9).
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** The result of the newest tool call the model was given back: what the last `work` call answered. */
function lastToolResult(): Record<string, unknown> {
	const call = [...h!.calls]
		.reverse()
		.find((c) => c.messages.at(-1)?.role === "tool")!;
	return JSON.parse(call.messages.at(-1)!.content) as Record<string, unknown>;
}

const answerCall = (
	todo: { id: string; revision: number },
	args: Record<string, unknown>,
) => ({
	name: "work",
	args: {
		todo: todo.id,
		operation: "answer",
		revision: todo.revision,
		...args,
	},
});

const saved = (operationId: string) => ({
	state: "saved",
	adapterRef: ADAPTER,
	operationId,
	digest: `digest-${operationId}`,
});

test("the work tool's answer is accepted once and the same run resumes the interaction", async () => {
	h = await setup();
	const first = await h.asked();
	const interaction = h.interaction()!;
	const [todo] = h.todos();
	expect(todo).toMatchObject({
		status: "waiting",
		questionId: interaction.question!.questionId,
	});
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 180 },
	});
	h.state.outcome = saved("op-nl");
	h.state.steps.push({
		calls: [
			answerCall(todo!, {
				questionId: todo!.questionId,
				text: "3分でお願い",
			}),
		],
	});
	const second = await h.say("3分でお願い");
	expect(second.id).not.toBe(first.id);
	// The accepted answer handed the work back to the command sub-agent: the generation ended with no more calls,
	// and the result is the conversation agent's to report on its own opportunity.
	expect(h.state.steps).toEqual([]);
	await until(() => h!.interaction()?.status === "completed");
	expect(h.interaction()).toMatchObject({
		status: "completed",
		receiptRef: { owner: "fake", operationId: "op-nl" },
	});
	// The utterance's own run resumed the interaction: no extra run was made, and the TODO moved to it.
	expect(
		h.rows("SELECT current_run_id FROM command_interactions")[0].current_run_id,
	).toBe(second.id);
	expect(h.rows("SELECT run_id FROM dialogue_work")[0].run_id).toBe(second.id);
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(2);
	// The command sub-agent saw the question and the answer as data, and the original request.
	const prompt = JSON.stringify(h.commandPrompts.at(-1));
	expect(prompt).toContain("previousQuestions");
	expect(prompt).toContain("3分でお願い");
	expect(prompt).toContain("何秒ですか");
	expect(h.started.at(-1)!.rootRunId).toBe(second.id);
	expect(h.started.at(-1)!.input.command.input).toEqual({ seconds: 180 });
	// The TODO ends with the operation's result.
	expect(h.todos()).toMatchObject([
		{ id: todo!.id, status: "done", outcome: "succeeded" },
	]);
	// The question was answered: the UI can no longer answer it.
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("interaction_closed");
});

test("an answer that is not the open question is refused with question_not_open and changes nothing", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const [todo] = h.todos();
	const jobs = () =>
		h!.rows("SELECT id FROM queue_jobs WHERE kind='dialogue.toolchain-command'")
			.length;
	const before = jobs();
	h.state.steps.push({
		calls: [
			answerCall(todo!, {
				questionId: crypto.randomUUID(),
				text: "3分",
			}),
		],
	});
	h.speak("どの質問か分かりません。");
	await h.say("3分");
	expect(lastToolResult()).toMatchObject({
		ok: false,
		code: "question_not_open",
	});
	expect(h.interaction()).toMatchObject({
		status: "waiting_input",
		revision: 0,
	});
	expect(h.todos()).toMatchObject([{ status: "waiting" }]);
	expect(jobs()).toBe(before);
	expect(
		h.rows("SELECT id FROM command_interaction_events WHERE kind='answer'"),
	).toHaveLength(0);
	expect(interaction.question).not.toBeNull();
});

test("an answer without text is refused with question_not_open", async () => {
	h = await setup();
	await h.asked();
	const [todo] = h.todos();
	h.state.steps.push({
		calls: [answerCall(todo!, { questionId: todo!.questionId })],
	});
	h.speak("答えがありません。");
	await h.say("お願い");
	expect(lastToolResult()).toMatchObject({
		ok: false,
		code: "question_not_open",
	});
	expect(h.interaction()!.status).toBe("waiting_input");
});

test("a second answer to the same question is refused: the TODO no longer waits", async () => {
	h = await setup();
	await h.asked();
	const [todo] = h.todos();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 60 },
	});
	h.state.outcome = saved("op-once");
	h.state.steps.push({
		calls: [answerCall(todo!, { questionId: todo!.questionId, text: "1分" })],
	});
	await h.say("1分");
	await until(() => h!.interaction()?.status === "completed");
	const [done] = h.todos();
	expect(done!.status).toBe("done");
	h.state.steps.push({
		calls: [answerCall(done!, { questionId: todo!.questionId, text: "2分" })],
	});
	h.speak("もう答えています。");
	const starts = h.started.length;
	await h.say("2分");
	// Finished work is not answered again: its result stays as reported.
	expect(lastToolResult()).toMatchObject({
		ok: false,
		code: "todo_done",
	});
	expect(h.started).toHaveLength(starts);
});

test("a stale TODO revision is refused before the answer is looked at", async () => {
	h = await setup();
	await h.asked();
	const [todo] = h.todos();
	h.state.steps.push({
		calls: [
			answerCall(
				{ id: todo!.id, revision: todo!.revision + 3 },
				{ questionId: todo!.questionId, text: "3分" },
			),
		],
	});
	h.speak("状態が変わっています。");
	await h.say("3分");
	expect(lastToolResult()).toMatchObject({
		ok: false,
		code: "revision_stale",
	});
	expect(h.interaction()!.status).toBe("waiting_input");
});

test("an answer to a question whose chain has since been replaced is refused and leaves the question open", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const [todo] = h.todos();
	// The catalog now offers a newer revision: the question's exact revision can no longer be rebuilt.
	h.state.activeRevision = "toolchain:fake.manage@2";
	h.state.steps.push({
		calls: [answerCall(todo!, { questionId: todo!.questionId, text: "3分" })],
	});
	h.speak("その担当はもう使えません。");
	await h.say("3分");
	expect(lastToolResult()).toMatchObject({
		ok: false,
		code: "toolchain_unavailable",
	});
	expect(h.started).toHaveLength(0);
	expect(h.interaction()!.status).toBe("waiting_input");
	// The UI's answer ends it with the reason.
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("version_invalidated");
	expect(h.interaction()!.status).toBe("cancelled");
});

test("an answer the UI gave completes the operation into the TODO that asked the question", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const [todo] = h.todos();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 180 },
	});
	h.state.outcome = saved("op-ui");
	await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 180 },
	});
	await until(() => h!.interaction()?.status === "completed");
	await until(() => h!.todos()[0]?.status !== "waiting");
	expect(h.todos()).toMatchObject([
		{ id: todo!.id, status: "done", outcome: "succeeded" },
	]);
});

test("a question asked again after a UI answer replaces the TODO's question", async () => {
	h = await setup();
	await h.asked("一つ目");
	const interaction = h.interaction()!;
	h.state.commands.push({ action: "clarify", question: "二つ目" });
	await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	});
	await until(
		() =>
			h!.interaction()?.question?.prompt === "二つ目" &&
			h!.interaction()?.status === "waiting_input",
	);
	await until(() => h!.todos()[0]?.question === "二つ目");
	expect(h.todos()[0]).toMatchObject({
		status: "waiting",
		questionId: h.interaction()!.question!.questionId,
	});
});
