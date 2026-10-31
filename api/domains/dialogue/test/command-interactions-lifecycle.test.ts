import { afterEach, expect, test } from "bun:test";
import { INTERACTION_POLICY } from "..";
import { insertInteraction } from "../repository/interactions";
import {
	BINDING,
	PACKAGE,
	REVISION,
	answerFor,
	choice,
	setup,
	until,
	type Harness,
} from "./command-interactions.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("an answer whose request id already belongs to another run is a conflict, not a link", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const eventId = crypto.randomUUID();
	// A run with this very request id and the answer's own text already exists.
	await h.dialogue.submit({
		requestId: eventId,
		conversationId: "main",
		text: '回答: {"durationSeconds":60}',
	});
	const before = h.rows("SELECT id FROM dialogue_runs").length;
	await expect(
		h.interactions.answer(interaction.id, {
			eventId,
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("request_conflict");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(before);
	expect(h.interaction()).toMatchObject({
		status: "waiting_input",
		revision: 0,
	});
});
test("a failed operation ends the interaction without a receipt", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 5 },
	});
	h.state.outcome = { state: "failed", errorCode: "revision_conflict" };
	await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 5 },
	});
	await until(() => h!.interaction()?.status === "cancelled");
	expect(h.interaction()!.receiptRef).toBeNull();
	expect(h.rows("SELECT end_code FROM command_interactions")[0].end_code).toBe(
		"revision_conflict",
	);
});
test("answers are refused for a stale question or revision, an invalid value, or a changed version", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const base = {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	};
	const runs = () => h!.rows("SELECT id FROM dialogue_runs").length;
	const before = runs();
	await expect(
		h.interactions.answer(interaction.id, {
			...base,
			questionId: crypto.randomUUID(),
		}),
	).rejects.toThrow("question_stale");
	await expect(
		h.interactions.answer(interaction.id, { ...base, expectedRevision: 3 }),
	).rejects.toThrow("revision_conflict");
	await expect(
		h.interactions.answer(interaction.id, {
			...base,
			input: { durationSeconds: 0 },
		}),
	).rejects.toThrow("invalid_answer");
	await expect(
		h.interactions.answer(crypto.randomUUID(), base),
	).rejects.toThrow("interaction_not_found");
	expect(runs()).toBe(before);
	expect(h.interaction()).toMatchObject({
		status: "waiting_input",
		revision: 0,
	});
	// The chain was replaced: the frozen refs no longer stand and the operation stops.
	h.state.activeRevision = "toolchain:fake.manage@2";
	await expect(h.interactions.answer(interaction.id, base)).rejects.toThrow(
		"version_invalidated",
	);
	expect(runs()).toBe(before);
	expect(h.interaction()!.status).toBe("cancelled");
});
test("an answer past the question's time is expired, not resumed", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	h.state.offset = INTERACTION_POLICY.answerTtlMs + 60_000;
	// A read already shows it expired; no question is offered any more.
	expect(h.interaction()).toMatchObject({ status: "expired", question: null });
	const before = h.rows("SELECT id FROM dialogue_runs").length;
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("interaction_expired");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(before);
	expect(h.rows("SELECT status FROM command_interactions")[0].status).toBe(
		"expired",
	);
});
test("maintenance expires open questions and ends interactions whose run is gone", async () => {
	h = await setup();
	await h.asked();
	h.state.offset = INTERACTION_POLICY.answerTtlMs + 60_000;
	expect(await h.interactions.maintenance()).toMatchObject({ expired: 1 });
	expect(h.rows("SELECT status FROM command_interactions")[0].status).toBe(
		"expired",
	);
});
test("an answer and its new run commit together: a refused job leaves the question open", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const runs = h.rows("SELECT id FROM dialogue_runs").length;
	const messages = h.conversation.get("main").messages.length;
	h.state.queueFull = true;
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("queue_full");
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(runs);
	expect(h.conversation.get("main").messages).toHaveLength(messages);
	expect(h.interaction()).toMatchObject({
		status: "waiting_input",
		revision: 0,
	});
	expect(
		h.rows("SELECT * FROM command_interaction_events WHERE kind='answer'"),
	).toHaveLength(0);
	// Once the queue accepts again, the same answer goes through.
	h.state.queueFull = false;
	const again = await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	});
	expect(again.replay).toBe(false);
});
test("at most three questions are asked; the fourth stops the operation", async () => {
	h = await setup();
	await h.asked("一つ目");
	for (const prompt of ["二つ目", "三つ目"]) {
		const current = h.interaction()!;
		h.state.commands.push({ action: "clarify", question: prompt });
		await h.interactions.answer(current.id, {
			eventId: crypto.randomUUID(),
			questionId: current.question!.questionId,
			expectedRevision: current.revision,
			input: answerFor(current.question!),
		});
		await until(
			() =>
				h!.interaction()?.question?.prompt === prompt &&
				h!.interaction()?.status === "waiting_input",
		);
	}
	expect(h.interaction()).toMatchObject({
		questionCount: 3,
		status: "waiting_input",
	});
	// The answer to the third question is the fourth clarification's trigger.
	const third = h.interaction()!;
	h.state.commands.push({ action: "clarify", question: "四つ目" });
	const { runId } = await h.interactions.answer(third.id, {
		eventId: crypto.randomUUID(),
		questionId: third.question!.questionId,
		expectedRevision: third.revision,
		input: answerFor(third.question!),
	});
	await until(() => h!.status(runId) === "failed");
	expect(h.dialogue.get(runId)?.error).toBe("question_limit_reached");
	expect(h.interaction()).toMatchObject({
		status: "cancelled",
		questionCount: 3,
	});
});
test("interactions are bounded: open and total capacity refuse a new one, and ending keeps the body for 30 days", async () => {
	h = await setup();
	const base = await h.asked();
	const template = h.rows("SELECT * FROM command_interactions")[0];
	await h.store.write((db) => {
		for (let i = 1; i < INTERACTION_POLICY.maxOpen; i++)
			insertInteraction(db, {
				id: `filler-${i}`,
				conversationId: template.conversation_id,
				originMessageId: template.origin_message_id,
				originRunId: base.id,
				currentRunId: base.id,
				chainRevisionId: REVISION,
				functionName: "fake_op",
				packageRevisionId: PACKAGE,
				bindingRevisionId: BINDING,
				artifactRevisionId: null,
				revision: 0,
				authorityEpoch: 0,
				executionGeneration: 0,
				status: "waiting_input",
				questionId: null,
				questionPrompt: "q",
				questionSchemaRef: "builtin:answerText",
				questionChoicesJson: null,
				questionCount: 1,
				requestText: "r",
				inputJson: null,
				requestId: crypto.randomUUID(),
				issuedAt: null,
				receiptOwner: null,
				receiptOperationId: null,
				receiptDigest: null,
				endCode: null,
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				endedAt: null,
				bodyDeletedAt: null,
			});
	});
	h.state.commands.push({ action: "clarify", question: "もう一件" });
	// The first TODO still waits for its answer: the pending turn is asked first, then the request turn delegates.
	h.state.steps.push(choice({ choice: "none" }));
	h.delegate("偽の操作を開始して");
	const run = await h.say("偽の操作を開始して", "failed");
	expect(h.dialogue.get(run.id)?.error).toBe("interaction_capacity");
});
test("ended interactions lose their bodies after 30 days and their rows after 30 more", async () => {
	h = await setup();
	await h.asked();
	h.state.offset = INTERACTION_POLICY.answerTtlMs + 60_000;
	expect(await h.interactions.maintenance()).toMatchObject({
		expired: 1,
		bodiesDeleted: 0,
		removed: 0,
	});
	h.state.offset += INTERACTION_POLICY.bodyRetentionMs + 60_000;
	expect(await h.interactions.maintenance()).toMatchObject({
		bodiesDeleted: 1,
	});
	const row = h.rows(
		"SELECT request_text, input_json, question_prompt, body_deleted_at FROM command_interactions",
	)[0];
	expect(row).toMatchObject({ request_text: null, question_prompt: null });
	expect(row.body_deleted_at).toBeString();
	expect(
		h
			.rows("SELECT payload_json FROM command_interaction_events")
			.every((e) => e.payload_json === null),
	).toBe(true);
	h.state.offset += INTERACTION_POLICY.tombstoneRetentionMs + 60_000;
	expect(await h.interactions.maintenance()).toMatchObject({ removed: 1 });
	expect(h.rows("SELECT id FROM command_interactions")).toHaveLength(0);
	expect(h.rows("SELECT id FROM command_interaction_events")).toHaveLength(0);
});
test("an interaction whose run ended without finishing it is closed", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	h.state.gate = new Promise<void>(() => {});
	await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	});
	await until(() => h!.commandPrompts.length === 2);
	// The process went away while the sub-agent was thinking.
	await h.store.write((db) =>
		db
			.query(
				"UPDATE dialogue_runs SET status='interrupted' WHERE status='running'",
			)
			.run(),
	);
	expect(await h.interactions.maintenance()).toMatchObject({ orphaned: 1 });
	expect(h.interaction()!.status).toBe("cancelled");
});
