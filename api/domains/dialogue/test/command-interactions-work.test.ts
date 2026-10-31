import { afterEach, expect, test } from "bun:test";
import { systemContext } from "../../../infrastructure/system-context";
import {
	ADAPTER,
	choice,
	resumedJobs,
	setup,
	until,
	type Harness,
} from "./command-interactions.fixture";

/**
 * A command toolchain's question is answered by the routed turn's pending choice (`answer`, which the host carries
 * out as the `work` operation) or by the UI through the interaction routes (the ContextWindow specification,
 * sections 6.1 and 9).
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** The pending turn's choice that answers a TODO's question by its number (`t<ref>`); the host takes the open question. */
const answerChoice = (todo: { ref: number }, fields: Record<string, unknown>) =>
	choice({ choice: "answer", todo: `t${todo.ref}`, ...fields });
/** What the host says when the work could not take the choice. */
const FAILED = systemContext("dialogue.contexts.local.failed", {});

const saved = (operationId: string) => ({
	state: "saved",
	adapterRef: ADAPTER,
	operationId,
	digest: `digest-${operationId}`,
});

test("the pending choice's answer is accepted once and the same run resumes the interaction", async () => {
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
	h.state.steps.push(answerChoice(todo!, { text: "3分でお願い" }));
	const second = await h.say("3分でお願い");
	expect(second.id).not.toBe(first.id);
	// The accepted answer handed the work back to the command sub-agent: the turn ended with the one choice, and
	// the result is the conversation agent's to report on its own opportunity.
	expect(h.state.steps).toEqual([]);
	expect(h.calls).toHaveLength(2);
	expect(h.calls.at(-1)!.session?.outputSchema).toBeDefined();
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
	// The TODO ends with the operation's result, archived as it finishes.
	expect(h.todos()).toEqual([]);
	expect(h.archived()).toMatchObject([
		{ id: todo!.id, status: "done", outcome: "succeeded" },
	]);
	// Its notice names the screen registered for the toolchain, so the notice can launch it.
	expect(h.notices().notices).toMatchObject([
		{ id: todo!.id, artifactId: "fake.workspace", read: false },
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

test("an answer without text is refused and changes nothing", async () => {
	h = await setup();
	await h.asked();
	const [todo] = h.todos();
	const jobs = resumedJobs(h).length;
	h.state.steps.push(answerChoice(todo!, { text: "" }));
	const run = await h.say("お願い");
	expect(h.dialogue.answerText(run.id)).toBe(FAILED);
	expect(h.interaction()!.status).toBe("waiting_input");
	expect(h.todos()).toMatchObject([{ status: "waiting" }]);
	expect(resumedJobs(h)).toHaveLength(jobs);
	expect(h.started).toHaveLength(0);
});

test("a second answer to the same question is refused: the TODO no longer waits and is not offered", async () => {
	h = await setup();
	await h.asked();
	const [todo] = h.todos();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 60 },
	});
	h.state.outcome = saved("op-once");
	h.state.steps.push(answerChoice(todo!, { text: "1分" }));
	await h.say("1分");
	await until(() => h!.interaction()?.status === "completed");
	expect(h.todos()).toEqual([]);
	const [done] = h.archived();
	expect(done!.status).toBe("done");
	// Finished work is archived as it finishes: no question is pending, so the request turn runs and offers no
	// choice on it. A choice that names it anyway is refused by the work operation and answers nothing.
	h.state.steps.push(
		choice({
			choice: `t${done!.ref}`,
			operation: "amend",
			text: "2分",
			say: "直します。",
		}),
	);
	const starts = h.started.length;
	const jobs = resumedJobs(h).length;
	const again = await h.say("2分");
	const schema = JSON.stringify(h.calls.at(-1)!.session?.outputSchema);
	// The finished TODO may only be checked: no answer and no correction of it is offered.
	expect(schema).not.toContain('"answer"');
	expect(schema).not.toContain('"amend"');
	expect(h.dialogue.answerText(again.id)).toBe(FAILED);
	expect(h.started).toHaveLength(starts);
	expect(resumedJobs(h)).toHaveLength(jobs);
});

test("a stale TODO revision is refused before the answer is looked at", async () => {
	h = await setup();
	await h.asked();
	const [todo] = h.todos();
	h.state.steps.push(answerChoice(todo!, { text: "3分" }));
	// The model call is held after its state was shown (revision as it stands now); the TODO's revision moves on
	// meanwhile, and the answer is then looked at against the revision the model saw.
	let release!: () => void;
	h.state.modelGate = new Promise<void>((resolve) => (release = resolve));
	const calls = h.calls.length;
	const said = h.say("3分");
	await until(() => h!.calls.length > calls);
	h.write(
		"UPDATE dialogue_work SET revision = revision + 1 WHERE id = ?",
		todo!.id,
	);
	h.state.modelGate = null;
	release();
	const run = await said;
	expect(h.dialogue.answerText(run.id)).toBe(FAILED);
	expect(h.interaction()!.status).toBe("waiting_input");
	expect(h.started).toHaveLength(0);
});

test("an answer to a question whose chain has since been replaced is refused and leaves the question open", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const [todo] = h.todos();
	// The catalog now offers a newer revision: the question's exact revision can no longer be rebuilt.
	h.state.activeRevision = "toolchain:fake.manage@2";
	h.state.steps.push(answerChoice(todo!, { text: "3分" }));
	const run = await h.say("3分");
	expect(h.dialogue.answerText(run.id)).toBe(FAILED);
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
	await until(() => h!.todos().length === 0);
	expect(h.archived()).toMatchObject([
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
