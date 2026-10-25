import { afterEach, expect, test } from "bun:test";
import { delegatedTaskRules } from "../../inference";
import {
	ADAPTER,
	REVISION,
	resumedJobs,
	setup,
	until,
	type Harness,
} from "./command-interactions.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a clarifying question is saved with the delegation's TODO and reaches the conversation, then is answered once by the UI", async () => {
	h = await setup();
	const first = await h.asked();
	const interaction = h.interaction()!;
	expect(interaction).toMatchObject({
		status: "waiting_input",
		questionCount: 1,
		revision: 0,
		chainRevisionId: REVISION,
		question: {
			prompt: "何秒ですか",
			inputSchemaRef: "builtin:timerDurationAnswer",
			revision: 0,
		},
	});
	// The TODO waits with the very question the interaction holds.
	expect(h.todos()).toMatchObject([
		{
			status: "waiting",
			questionId: interaction.question!.questionId,
			question: "何秒ですか",
		},
	]);
	// The question reaches the user through the conversation agent: it is told the TODO changed, and reads the
	// waiting TODO with its question on its own opportunity (no generation is made for the change).
	expect(h.workChanged).toContain("main");
	const body = {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: interaction.revision,
		input: { durationSeconds: 180 },
	};
	const before = h.rows("SELECT id FROM dialogue_runs").length;
	const answered = await h.interactions.answer(interaction.id, body);
	expect(answered.replay).toBe(false);
	expect(answered.interaction).toMatchObject({
		status: "ready",
		revision: 1,
		question: null,
	});
	// Exactly one run, its user message and its command job were created together.
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(before + 1);
	const text = h.conversation
		.get("main")
		.messages.find(
			(m) => m.runId === answered.runId && m.role === "user",
		)!.text;
	expect(text).toContain("180");
	expect(JSON.parse(resumedJobs(h).at(-1).payload_json)).toMatchObject({
		runId: answered.runId,
		toolchainRevisionId: REVISION,
		interactionId: interaction.id,
	});
	// The same event replays to the same run; another input under it conflicts.
	const replay = await h.interactions.answer(interaction.id, body);
	expect(replay).toMatchObject({ replay: true, runId: answered.runId });
	await expect(
		h.interactions.answer(interaction.id, {
			...body,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("request_conflict");
	// A second answer to the same question is closed.
	await expect(
		h.interactions.answer(interaction.id, {
			...body,
			eventId: crypto.randomUUID(),
		}),
	).rejects.toThrow("interaction_closed");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(before + 1);
	expect(first.id).not.toBe(answered.runId);
});

test("the resumed command run gets the question and the answer as data and completes the interaction with the receipt", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 180 },
	});
	h.state.outcome = {
		state: "saved",
		adapterRef: ADAPTER,
		operationId: "op-1",
		digest: "digest-1",
	};
	const { runId } = await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 180 },
	});
	await until(() => h!.interaction()?.status === "completed");
	expect(h.interaction()).toMatchObject({
		status: "completed",
		receiptRef: { owner: "fake", operationId: "op-1", digest: "digest-1" },
	});
	const prompt = JSON.stringify(h.commandPrompts.at(-1));
	expect(prompt).toContain("previousQuestions");
	expect(h.commandPrompts.at(-1)![0]!.content).toContain(delegatedTaskRules);
	expect(h.commandPrompts.at(-1)).toHaveLength(2);
	expect(prompt).toContain("何秒ですか");
	expect(prompt).toContain("durationSeconds");
	// The original request is the first utterance, not the answer's.
	expect(prompt).toContain("偽の操作を開始して");
	expect(h.started.at(-1)!.rootRunId).toBe(runId);
	expect(h.started.at(-1)!.input.command.input).toEqual({ seconds: 180 });
	// The frozen input and the time it was decided are kept.
	const row = h.rows(
		"SELECT input_json, issued_at, request_id FROM command_interactions",
	)[0];
	expect(JSON.parse(row.input_json)).toEqual({ seconds: 180 });
	expect(row.issued_at).toBeString();
	expect(row.request_id).toBeString();
	// The domain operation carries exactly those: the logical request id and decision time.
	expect(h.started.at(-1)!.input.command.stamp).toEqual({
		requestId: row.request_id,
		issuedAt: row.issued_at,
	});
});

test("a target question carries the host's choices and accepts only one of them", async () => {
	h = await setup();
	h.state.choices["builtin:timerTargetAnswer"] = [
		{ ref: "timer-1", label: "お茶（残り60秒・動作中）" },
		{ ref: "timer-2", label: "麺（残り120秒・一時停止）" },
	];
	await h.asked("どのタイマーですか", "builtin:timerTargetAnswer");
	const interaction = h.interaction()!;
	expect(interaction.question).toMatchObject({
		inputSchemaRef: "builtin:timerTargetAnswer",
		choices: h.state.choices["builtin:timerTargetAnswer"],
	});
	const body = (timerId: string) => ({
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { timerId },
	});
	const runs = h.rows("SELECT id FROM dialogue_runs").length;
	// A well-formed id the host did not issue with this question is not an answer.
	await expect(
		h.interactions.answer(interaction.id, body(crypto.randomUUID())),
	).rejects.toThrow("invalid_answer");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(runs);
	const accepted = await h.interactions.answer(interaction.id, body("timer-2"));
	expect(accepted.replay).toBe(false);
});

test("a binding without questions allows only free text, and the model is offered no other schema", async () => {
	h = await setup({ questions: [], autoStart: false });
	h.state.commands.push({
		action: "clarify",
		question: "何秒ですか",
		answerSchema: "builtin:timerDurationAnswer",
	});
	const refused = await h.commandRun();
	await until(() => h!.status(refused.id) === "failed");
	expect(h.dialogue.get(refused.id)?.error).toBe(
		"toolchain_command_invalid_contract",
	);
	expect(h.commandSchemas[0]).not.toContain("timerDurationAnswer");
	expect(h.commandSchemas[0]).toContain("builtin:answerText");
	expect(h.rows("SELECT id FROM command_interactions")).toHaveLength(0);
});

test("free text is always allowed: a binding without questions asks builtin:answerText", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	expect(h.interaction()!.question!.inputSchemaRef).toBe("builtin:answerText");
});

test("a binding with questions offers exactly those schemas to the model", async () => {
	h = await setup({ autoStart: false });
	h.state.commands.push({ action: "clarify", question: "どれ" });
	await h.commandRun();
	await until(() => h!.commandPrompts.length === 1);
	expect(h.commandSchemas[0]).toContain("builtin:timerDurationAnswer");
	expect(h.commandSchemas[0]).toContain("builtin:timerTargetAnswer");
	expect(h.commandSchemas[0]).toContain("builtin:answerText");
});

test("the choice field is the binding's: a schema with another field is validated the same way", async () => {
	h = await setup({
		questions: [
			{ inputSchemaRef: "schema:pick-item@1", choiceField: "itemId" },
		],
	});
	h.state.choices["schema:pick-item@1"] = [
		{ ref: "item-a", label: "A" },
		{ ref: "item-b", label: "B" },
	];
	await h.asked("どの項目ですか", "schema:pick-item@1");
	const interaction = h.interaction()!;
	expect(interaction.question).toMatchObject({
		inputSchemaRef: "schema:pick-item@1",
		choices: h.state.choices["schema:pick-item@1"],
	});
	const body = (itemId: string) => ({
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { itemId },
	});
	await expect(
		h.interactions.answer(interaction.id, body("item-z")),
	).rejects.toThrow("invalid_answer");
	expect(
		(await h.interactions.answer(interaction.id, body("item-b"))).replay,
	).toBe(false);
});

test("a schema without a choice field carries no choices even if the host has some", async () => {
	h = await setup();
	h.state.choices["builtin:timerDurationAnswer"] = [{ ref: "x", label: "X" }];
	await h.asked();
	expect(h.interaction()!.question).toMatchObject({
		inputSchemaRef: "builtin:timerDurationAnswer",
	});
	expect(h.interaction()!.question!.choices).toBeUndefined();
});

test("a target question without host choices is asked as free text", async () => {
	h = await setup();
	await h.asked("どのタイマーですか", "builtin:timerTargetAnswer");
	const question = h.interaction()!.question!;
	expect(question.inputSchemaRef).toBe("builtin:answerText");
	expect(question.choices).toBeUndefined();
});
