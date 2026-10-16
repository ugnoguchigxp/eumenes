import { afterEach, expect, test } from "bun:test";
import { INTERACTION_POLICY } from "..";
import { insertInteraction } from "../repository/interactions";
import {
	REVISION,
	BINDING,
	PACKAGE,
	ADAPTER,
	operationCall,
	lastUser,
	pause,
	until,
	open,
	setup,
	answerFor,
	resumedJobs,
} from "./command-interactions.fixture";
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});
test("an answer whose request id already belongs to another run is a conflict, not a link", async () => {
	const h = setup();
	await h.clarified();
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
	const h = setup();
	await h.clarified();
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
	await until(() => h.interaction()?.status === "cancelled");
	expect(h.interaction()!.receiptRef).toBeNull();
	expect(h.rows("SELECT end_code FROM command_interactions")[0].end_code).toBe(
		"revision_conflict",
	);
});
test("answers are refused for a stale question or revision, an invalid value, or a changed version", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	const base = {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	};
	const runs = () => h.rows("SELECT id FROM dialogue_runs").length;
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
	const h = setup();
	await h.clarified();
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
	const h = setup();
	await h.clarified();
	h.state.offset = INTERACTION_POLICY.answerTtlMs + 60_000;
	expect(await h.interactions.maintenance()).toMatchObject({ expired: 1 });
	expect(h.rows("SELECT status FROM command_interactions")[0].status).toBe(
		"expired",
	);
});
test("an answer and its new run commit together: a refused job leaves the question open", async () => {
	const h = setup();
	await h.clarified();
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
	const h = setup();
	await h.clarified("一つ目");
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
				h.interaction()?.question?.prompt === prompt &&
				h.interaction()?.status === "waiting_input",
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
	await until(() => h.status(runId) === "failed");
	expect(h.dialogue.get(runId)?.error).toBe("question_limit_reached");
	expect(h.interaction()).toMatchObject({
		status: "cancelled",
		questionCount: 3,
	});
});
test("cancelling closes the question, refuses a late answer and stops a resumed run still in flight", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	const cancelled = await h.interactions.cancel(interaction.id, {
		eventId: crypto.randomUUID(),
		expectedRevision: 0,
	});
	expect(cancelled).toMatchObject({ status: "cancelled", question: null });
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: 0,
			input: { durationSeconds: 60 },
		}),
	).rejects.toThrow("interaction_closed");
	// Epoch and generation advanced.
	const row = h.rows(
		"SELECT authority_epoch, execution_generation FROM command_interactions",
	)[0];
	expect(row.authority_epoch).toBeGreaterThan(0);
	expect(row.execution_generation).toBeGreaterThan(0);
	// Cancelling again is idempotent.
	expect(
		(
			await h.interactions.cancel(interaction.id, {
				eventId: crypto.randomUUID(),
				expectedRevision: 5,
			})
		).status,
	).toBe("cancelled");
});
test("a model result that arrives after the interaction was cancelled is not adopted", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 60 },
	});
	const { runId } = await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	});
	await until(() => h.commandPrompts.length === 2);
	await h.interactions.cancel(interaction.id, {
		eventId: crypto.randomUUID(),
		expectedRevision: 1,
	});
	release();
	await until(() => h.status(runId) === "cancelled");
	await pause(50);
	expect(h.started).toHaveLength(0);
	expect(h.interaction()!.status).toBe("cancelled");
});
test("a reply in natural language answers an open question through its questionRef, and only that", async () => {
	let ref = "";
	const h = setup({
		conversation: (call) => {
			if (!call.tools.length) return undefined;
			const text = lastUser(call.history);
			if (text === "3分でお願い")
				return {
					toolCalls: operationCall({ request: text, questionRef: ref }),
				};
			if (text === "もう一度") return {};
			return undefined;
		},
	});
	h.state.commands.push({ action: "clarify", question: "何秒ですか" });
	const first = await h.run("偽の操作を開始して");
	await until(() => h.status(first.id) === "completed");
	// With no open question the function takes only `request`.
	expect(
		Object.keys(
			(h.conversationCalls[0]!.tools[0]!.function.parameters as any).properties,
		),
	).toEqual(["request"]);
	const interaction = h.interaction()!;
	ref = interaction.question!.questionId;
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 180 },
	});
	h.state.outcome = {
		state: "saved",
		adapterRef: ADAPTER,
		operationId: "op-nl",
		digest: "digest-nl",
	};
	const second = await h.run("3分でお願い");
	await until(() => h.interaction()?.status === "completed");
	// The conversation saw the open question as data and could name only its ref.
	const call = h.conversationCalls.find((c) =>
		c.history.some((m) => m.content.includes("openQuestions")),
	)!;
	expect(JSON.stringify(call.history)).toContain(ref);
	expect(
		(call.tools[0]!.function.parameters as any).properties.questionRef.enum,
	).toEqual([ref]);
	// The utterance's own run resumed the interaction; no extra run was made.
	expect(
		h.rows("SELECT current_run_id FROM command_interactions")[0].current_run_id,
	).toBe(second.id);
	expect(JSON.stringify(h.commandPrompts.at(-1))).toContain("3分でお願い");
	expect(h.started.at(-1)!.rootRunId).toBe(second.id);
	expect(h.rows("SELECT id FROM dialogue_runs")).toHaveLength(2);
	// Answered once: the question is no longer offered.
	const third = await h.run("もう一度");
	await until(() => h.status(third.id) === "completed");
	expect(
		h.conversationCalls
			.at(-1)!
			.history.some((m) => m.content.includes("openQuestions")),
	).toBe(false);
});
test("a questionRef that is not an open question of the offered function is rejected", async () => {
	const h = setup({
		conversation: (call) =>
			call.tools.length
				? {
						toolCalls: operationCall({
							request: "3分でお願い",
							questionRef: crypto.randomUUID(),
						}),
					}
				: undefined,
	});
	const run = await h.run("3分でお願い");
	await until(() => h.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe("invalid_conversation_operation");
	expect(resumedJobs(h)).toHaveLength(0);
});
test("a natural-language answer to a question whose chain has since changed stops with version_invalidated", async () => {
	let ref = "";
	const h = setup({
		conversation: (call) =>
			call.tools.length && lastUser(call.history) === "3分"
				? { toolCalls: operationCall({ request: "3分", questionRef: ref }) }
				: undefined,
	});
	await h.clarified();
	ref = h.interaction()!.question!.questionId;
	// The offer now names a newer revision of the same function.
	h.state.activeRevision = "toolchain:fake.manage@2";
	const run = await h.run("3分");
	await until(() => h.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe("version_invalidated");
	expect(h.interaction()!.status).toBe("cancelled");
	expect(h.started).toHaveLength(0);
});
test("interactions are bounded: open and total capacity refuse a new one, and ending keeps the body for 30 days", async () => {
	const h = setup();
	const base = await h.clarified();
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
	const run = await h.run("偽の操作を開始して");
	await until(() => h.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe("interaction_capacity");
});
test("ended interactions lose their bodies after 30 days and their rows after 30 more", async () => {
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	await h.interactions.cancel(interaction.id, {
		eventId: crypto.randomUUID(),
		expectedRevision: 0,
	});
	expect(await h.interactions.maintenance()).toMatchObject({
		bodiesDeleted: 0,
		removed: 0,
	});
	h.state.offset = INTERACTION_POLICY.bodyRetentionMs + 60_000;
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
	const h = setup();
	await h.clarified();
	const interaction = h.interaction()!;
	h.state.gate = new Promise<void>(() => {});
	await h.interactions.answer(interaction.id, {
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 60 },
	});
	await until(() => h.commandPrompts.length === 2);
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
