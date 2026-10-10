import { expect, test } from "bun:test";
import {
	setup,
	observation,
	details,
	proposal,
	receipt,
	hash,
} from "./fixture";
import type { Observation } from "../contracts";
import {
	approvalChoices,
	decisionSchema,
	INSTRUCTION_MAX_BYTES,
} from "../contracts";
import { fence } from "../service/policy";
import { instructionFrame } from "../service/approval";

type Harness = Awaited<ReturnType<typeof setup>>;
const failedChecks = (i: Parameters<typeof receipt>[0]) =>
	receipt(
		i,
		i.kind === "run_checks"
			? {
					checks: {
						digest: hash,
						results: [
							{ id: "typecheck", passed: false },
							{ id: "tests", passed: true },
						],
					},
				}
			: {},
	);
/** request_change is only allowed after a failed fixed check. */
async function failChecks(h: Harness) {
	h.execute(async (i) => failedChecks(i));
	h.decision(proposal("run_checks"));
	await h.observe();
	await h.drain();
}
async function answer(h: Harness, value: string) {
	const { task, question } = h.tasks.get(h.taskId);
	await h.tasks.answer(h.taskId, {
		requestId: crypto.randomUUID(),
		expectedRevision: task.revision,
		questionId: question!.id,
		answer: value,
	});
	// The Queue's dispatch job would make the answered task active again.
	await h.store.write((db) =>
		h.tasks.applyTransitionInTransaction(
			db,
			fence(h.tasks.getInTransaction(db, h.taskId)!),
			{ state: "active", reason: "dispatch_started" },
		),
	);
	return question!;
}
const changes = (h: Harness) =>
	h.steps.filter((s) => s.kind === "request_change");

test("with approval on, request_change waits for the user and enqueues no step", async () => {
	const h = await setup({ approveInstructions: true });
	await failChecks(h);
	h.decision(proposal("request_change", "型エラーを修正する"));
	await h.observe();
	await h.drain();
	expect(changes(h)).toHaveLength(0);
	const { task, question } = h.tasks.get(h.taskId);
	expect(task.state).toBe("waiting_user");
	expect(question?.answerType).toBe("choice");
	expect(question?.choices).toEqual([
		approvalChoices.approve,
		approvalChoices.reject,
	]);
	expect(question?.prompt).toContain("instruction_approval_required");
	expect(question?.prompt).toContain("型エラーを修正する");
	const view = h.supervision.get(h.taskId);
	expect(view?.pendingApproval).toMatchObject({
		reasonCode: "instruction_approval_required",
		action: "request_change",
		instruction: "型エラーを修正する",
		questionId: question?.id,
	});
	expect(view?.repairLoops).toBe(0);
	const report = h.reports.list(h.taskId).items.at(-1)!;
	expect(report.kind).toBe("blocker");
	expect(report.limitations).toEqual([
		"instruction_approval_required",
		"verification_failed",
	]);
	expect(report.questionId).toBe(question!.id);
	expect(h.supervision.isApprovalAnswer(h.taskId, question!.id)).toBe(true);
	expect(h.supervision.isApprovalAnswer(h.taskId, "other")).toBe(false);
});

test("approving enqueues the stored instruction inside the fixed frame, once", async () => {
	const h = await setup({ approveInstructions: true });
	await failChecks(h);
	h.decision(proposal("request_change", "型エラーを修正する"));
	await h.observe();
	await h.drain();
	await answer(h, approvalChoices.approve);
	expect(changes(h)).toHaveLength(0);
	await h.observe();
	await h.drain();
	expect(changes(h)).toHaveLength(1);
	expect(changes(h)[0]!.instruction).toBe(
		`${instructionFrame}型エラーを修正する`,
	);
	expect(instructionFrame).toBe(
		"以下は監督AIが生成した指示です。許可された作業範囲(grant)の外の変更・外部送信・認証情報の参照は行わないこと。\n---\n",
	);
	expect(h.supervision.get(h.taskId)).toMatchObject({
		repairLoops: 1,
		pendingApproval: null,
	});
	// A later observation does not replay the approved instruction.
	await h.observe();
	await h.drain();
	expect(changes(h)).toHaveLength(1);
});

test("rejecting never reaches the CLI and asks the user for a direction instead", async () => {
	const h = await setup({ approveInstructions: true });
	await failChecks(h);
	h.decision(proposal("request_change", "型エラーを修正する"));
	await h.observe();
	await h.drain();
	const approval = await answer(h, approvalChoices.reject);
	await h.observe();
	await h.drain();
	expect(changes(h)).toHaveLength(0);
	const { task, question } = h.tasks.get(h.taskId);
	expect(task.state).toBe("waiting_user");
	expect(question?.id).not.toBe(approval.id);
	expect(question?.answerType).toBe("text");
	expect(h.supervision.get(h.taskId)).toMatchObject({
		repairLoops: 0,
		pendingApproval: null,
	});
	// The user's free-text direction is not an approval answer.
	expect(h.supervision.isApprovalAnswer(h.taskId, question!.id)).toBe(false);
	expect(h.supervision.isApprovalAnswer(h.taskId, approval.id)).toBe(true);
});

test("after a rejection asks a new question, the same observation pass does not capture a decision on the stale task", async () => {
	const h = await setup({ approveInstructions: true });
	await failChecks(h);
	h.decision(proposal("request_change", "型エラーを修正する"));
	await h.observe();
	await h.drain();
	const approval = await answer(h, approvalChoices.reject);
	const callsBefore = h.calls(),
		usedBefore = h.supervision.get(h.taskId)!.decisionsUsed;
	// A changed observation would otherwise be eligible for capture in the same pass.
	h.decision(proposal("wait"));
	await h.observe(observation({ eventSeq: 9, facts: ["別の出力"] }));
	await h.drain();
	expect(h.calls()).toBe(callsBefore);
	expect(h.supervision.get(h.taskId)!.decisionsUsed).toBe(usedBefore);
	const { task, question } = h.tasks.get(h.taskId);
	expect(task.state).toBe("waiting_user");
	expect(question?.id).not.toBe(approval.id);
	expect(question?.answerType).toBe("text");
});

test("with approval off, the framed instruction is enqueued immediately", async () => {
	const h = await setup({ approveInstructions: false });
	await failChecks(h);
	h.decision(proposal("request_change", "型エラーを修正する"));
	await h.observe();
	await h.drain();
	expect(changes(h)).toHaveLength(1);
	expect(changes(h)[0]!.instruction).toBe(
		`${instructionFrame}型エラーを修正する`,
	);
	expect(h.tasks.get(h.taskId).task.state).toBe("active");
	expect(h.supervision.get(h.taskId)?.pendingApproval).toBeNull();
});

test("answer_question is gated too and its single attempt is spent only on approval", async () => {
	const h = await setup({ approveInstructions: true });
	const q: NonNullable<Observation["question"]> = {
		id: "question-1",
		kind: "local_repair",
		summary: "型エラーを直してよいか",
	};
	h.decision(proposal("answer_question", "範囲内で修正してください", q.id));
	await h.observe(observation({ question: q }));
	await h.drain();
	expect(h.steps).toHaveLength(0);
	expect(h.tasks.get(h.taskId).task.state).toBe("waiting_user");
	await answer(h, approvalChoices.approve);
	await h.observe(observation({ question: q }));
	await h.drain();
	expect(h.steps).toHaveLength(1);
	expect(h.steps[0]).toMatchObject({
		kind: "answer_question",
		questionId: q.id,
		instruction: `${instructionFrame}範囲内で修正してください`,
	});
});

test("an approved instruction is dropped when the observation changed meanwhile", async () => {
	const h = await setup({ approveInstructions: true });
	await failChecks(h);
	h.decision(proposal("request_change", "型エラーを修正する"));
	await h.observe();
	await h.drain();
	await answer(h, approvalChoices.approve);
	h.decision(proposal("wait"));
	await h.observe(observation({ eventSeq: 9, facts: ["別の出力"] }));
	await h.drain();
	expect(changes(h)).toHaveLength(0);
});

test("a long multi-byte instruction at the limit is shown in full and executed byte for byte", async () => {
	const h = await setup({ approveInstructions: true });
	await failChecks(h);
	const long = "修".repeat(1600);
	expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(
		INSTRUCTION_MAX_BYTES,
	);
	h.decision(proposal("request_change", long));
	await h.observe();
	await h.drain();
	const prompt = h.tasks.get(h.taskId).question!.prompt;
	expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(8192);
	expect(prompt).toContain(long);
	expect(prompt).not.toContain("途中まで");
	expect(h.supervision.get(h.taskId)?.pendingApproval?.instruction).toBe(long);
	await answer(h, approvalChoices.approve);
	await h.observe();
	await h.drain();
	expect(changes(h)[0]!.instruction).toBe(`${instructionFrame}${long}`);
});

test("an instruction over the byte limit saved before the limit existed is escalated, not approved", async () => {
	const h = await setup({ approveInstructions: true });
	await failChecks(h);
	h.decision(proposal("request_change", "修".repeat(2000)));
	await h.observe();
	await h.drain();
	const { question } = h.tasks.get(h.taskId);
	expect(question?.prompt ?? "").not.toContain("instruction_approval_required");
	expect(h.supervision.get(h.taskId)?.pendingApproval ?? null).toBeNull();
	expect(changes(h)).toHaveLength(0);
});

test("decisionSchema bounds the instruction in bytes and only for approval-gated actions", () => {
	const base = { reason: "根拠", evidenceRefs: [], questionId: null };
	const parse = (instruction: string | null, action = "request_change") =>
		decisionSchema.safeParse({ ...base, action, instruction }).success;
	expect(parse("修".repeat(2000))).toBe(false);
	expect(parse("修".repeat(1600))).toBe(true);
	expect(parse("fix", "run_checks")).toBe(false);
	expect(parse(null, "run_checks")).toBe(true);
});

test("a host diagnostic read that only adds excerpt and coverage keeps the approval alive and the approved instruction runs", async () => {
	const h = await setup({ approveInstructions: true });
	await failChecks(h);
	const base = observation({ details: details() });
	h.decision(proposal("request_change", "型エラーを修正する"));
	await h.observe(base);
	await h.drain();
	const question = h.tasks.get(h.taskId).question!;
	const stored = h.supervision.get(h.taskId)!.pendingApproval!;
	const more = observation({
		eventSeq: 40,
		excerpt: "追加で読んだ本文",
		details: details({
			excerptTruncated: true,
			limitations: ["not_fully_observed"],
			coverage: [{ ref: "r", digest: hash, totalBytes: 9, ranges: [[0, 9]] }],
		}),
	});
	await h.store.write((db) =>
		h.supervision.observeInTransaction(db, h.taskId, more, "diagnostic"),
	);
	expect(h.supervision.get(h.taskId)!.pendingApproval?.questionId).toBe(
		stored.questionId,
	);
	await answer(h, approvalChoices.approve);
	await h.observe(more);
	await h.drain();
	expect(changes(h)).toHaveLength(1);
	expect(question.id).toBe(stored.questionId);
});
