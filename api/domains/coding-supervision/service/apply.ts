import type { Database } from "bun:sqlite";
import type { WorkTask } from "../../tasks";
import {
	stepKinds,
	type Decision,
	type StepIntent,
	type StepKind,
	type Supervisor,
} from "../contracts";
import * as repo from "../repository";
import type { WorkflowPort } from "../contracts";
import {
	allowedActions,
	blockerKey,
	checked,
	digest,
	fence,
	operationFor,
	phaseFor,
	reviewed,
	stopped,
} from "./policy";
import type { createApproval } from "./approval";
import { frameInstruction } from "./approval";
import type { SupervisionContext } from "./context";
import type { Holds } from "./holds";
import { evidence } from "./report";

/** Turns an accepted decision into a completion, an escalation, an approval request or a queued step. */
export function createApplier(
	ctx: SupervisionContext,
	deps: { holds: Holds; approval: ReturnType<typeof createApproval> },
) {
	const { tasks, queue, workflow, approveInstructions, report } = ctx;
	const { hold, escalate } = deps.holds;
	const { approval } = deps;
	function complete(db: Database, t: WorkTask, s: Supervisor, d: Decision) {
		if (!stopped(s) || !checked(s) || !reviewed(s) || !evidence(s).length) {
			hold(db, t, s, "supervision_completion_unconfirmed");
			return;
		}
		const completed = d.action === "finish_candidate";
		tasks().applyTransitionInTransaction(db, fence(t), {
			state: completed ? "completed" : "failed",
			phase: "finalizing",
			reason: completed ? "supervision_completed" : "supervision_failed",
			result: {
				summary: d.reason,
				evidenceRefs: evidence(s),
				conditionsMet: s.checks!.conditionsMet,
			},
		});
		report(
			db,
			tasks().getInTransaction(db, t.id)!,
			s,
			completed ? "completed" : "failed",
			d.reason,
			completed ? "completed" : "failed",
		);
		return;
	}
	/** Validates the registered policy, then records the step intent and enqueues its job. */
	function prepareStep(
		db: Database,
		t: WorkTask,
		s: Supervisor,
		d: Decision,
		kind: StepKind,
		policy: ReturnType<WorkflowPort["policy"]>,
	) {
		if (
			!policy.checkIds.length ||
			policy.checkIds.length > 20 ||
			new Set(policy.checkIds).size !== policy.checkIds.length ||
			![policy.checksDigest, policy.reviewPolicyDigest].every((v) =>
				/^[a-f0-9]{64}$/.test(v),
			)
		) {
			hold(db, t, s, "supervision_policy_unavailable");
			return;
		}
		if (kind !== "inspect_more")
			tasks().applyTransitionInTransaction(db, fence(t), {
				state: "active",
				phase: phaseFor[kind],
				reason: "supervision_step_prepared",
			});
		const latest = tasks().getInTransaction(db, t.id)!;
		const intent: StepIntent = {
			id: crypto.randomUUID(),
			taskId: t.id,
			generation: t.executionGeneration,
			authorityEpoch: t.authorityEpoch,
			revision: latest.revision,
			kind,
			executionId: s.observation!.executionId,
			snapshotHash: s.observation!.snapshotHash,
			implementationSessionId: s.observation!.sessionId,
			observationDigest: digest(s.observation),
			instruction:
				d.instruction === null ? null : frameInstruction(d.instruction),
			questionId: d.questionId,
			deadline: Math.min(
				Date.parse(t.grant.expiresAt),
				Date.parse(t.executionDeadlineAt!),
			),
			policy: structuredClone(policy),
			branch: t.grant.branch,
			remote: t.grant.remote,
		};
		const { job } = queue.enqueueInTransaction(db, {
			scope: `supervision:${t.id}`,
			kind: "coding-supervision.step.v1",
			payload: { id: intent.id },
			dedupeKey: intent.id,
			subjectRef: t.id,
			lane: "background",
			concurrencyKey: `supervision:${t.id}:step`,
			deadlineAtMs: intent.deadline,
			maxAttempts: 1,
		});
		repo.putStep(db, { intent, status: "pending", jobId: job.id });
		s.stepId = intent.id;
	}
	function apply(
		db: Database,
		t: WorkTask,
		s: Supervisor,
		d: Decision,
		approved = false,
	) {
		if (
			!allowedActions(t, s).includes(d.action) ||
			!d.evidenceRefs.every((r) => evidence(s).includes(r))
		) {
			escalate(
				db,
				t,
				s,
				"監督の判断が許可範囲または証拠と一致しません。続行方針の確認が必要です。",
			);
			return;
		}
		if (d.action === "wait") return;
		if (d.action === "escalate") {
			escalate(db, t, s, s.observation?.question?.summary ?? d.reason);
			return;
		}
		if (!workflow.available()) {
			escalate(db, t, s, "検証・レビュー用の実行環境が利用できません。");
			return;
		}
		const policy = workflow.policy(t.id);
		if (
			(s.checks && s.checks.checks?.digest !== policy.checksDigest) ||
			(s.review && s.review.review?.policyDigest !== policy.reviewPolicyDigest)
		) {
			s.checks = null;
			s.review = null;
			s.commit = null;
			s.push = null;
			escalate(
				db,
				t,
				s,
				"登録済みの検証・レビュー定義が変わりました。再検証の方針を確認してください。",
			);
			return;
		}
		if (d.action === "finish_candidate" || d.action === "fail_candidate") {
			complete(db, t, s, d);
			return;
		}
		const kind = d.action as StepKind;
		if (
			!stepKinds.includes(kind) ||
			!t.grant.operations.includes(operationFor[kind])
		) {
			hold(db, t, s, "supervision_operation_not_granted");
			return;
		}
		if (kind === "answer_question") {
			const q = s.observation!.question;
			if (
				!q ||
				q.id !== d.questionId ||
				q.kind !== "local_repair" ||
				(s.blockerAttempts[blockerKey(s)] ?? 0) >= 1
			) {
				escalate(db, t, s, "この質問には自動回答できません。");
				return;
			}
		}
		if (kind === "request_change" && s.repairLoops >= 2) {
			escalate(db, t, s, "修正回数の上限に達しました。");
			return;
		}
		if (
			!approved &&
			(kind === "answer_question" || kind === "request_change") &&
			approveInstructions()
		) {
			approval.request(db, t, s, d);
			return;
		}
		if (kind === "answer_question")
			s.blockerAttempts[blockerKey(s)] =
				(s.blockerAttempts[blockerKey(s)] ?? 0) + 1;
		if (kind === "request_change") s.repairLoops++;
		prepareStep(db, t, s, d, kind, policy);
	}
	return { apply };
}
