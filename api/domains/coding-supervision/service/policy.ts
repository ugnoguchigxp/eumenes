import { sha256Hex } from "../../../infrastructure/digest";
import { canonicalJSON } from "../../../../packages/coding-runner/src/contracts";
import type { WorkTask, CodingWorkTask, TaskFence } from "../../tasks";
import type {
	Observation,
	Supervisor,
	StepKind,
	StepReceipt,
	StepIntent,
} from "../contracts";
export const fence = (t: WorkTask): TaskFence => ({
	taskId: t.id,
	expectedRevision: t.revision,
	authorityEpoch: t.authorityEpoch,
	executionGeneration: t.executionGeneration,
});
export const live = (t: WorkTask, at: number) =>
	t.kind === "coding" &&
	["queued", "active", "waiting_user", "reconciling"].includes(t.state) &&
	!t.bodyExpired &&
	Date.parse(t.grant.expiresAt) > at &&
	t.executionDeadlineAt !== null &&
	Date.parse(t.executionDeadlineAt) > at;
export const stopped = (s: Supervisor) =>
	s.observation?.turnFinished === true &&
	// Failed, cancelled, conflicting or unconfirmed turns never open mutation, even with a final answer.
	(s.observation.details === undefined ||
		s.observation.details.run.turnOutcome === "completed") &&
	s.observation.childrenStopped &&
	s.observation.evidenceComplete;
export const blockerKey = (s: Supervisor) => {
	const q = s.observation?.question;
	return q ? sha256Hex(JSON.stringify([q.kind, q.summary])) : "none";
};
export function checked(s: Supervisor) {
	return (
		!!s.checks &&
		s.checks.snapshotHash === s.observation?.snapshotHash &&
		s.checks.checks?.results.every((r) => r.passed) === true
	);
}
export function reviewed(s: Supervisor) {
	return (
		!!s.review &&
		s.review.snapshotHash === s.observation?.snapshotHash &&
		s.review.review?.findings.length === 0
	);
}
export function allowedActions(t: WorkTask, s: Supervisor): string[] {
	if (t.kind !== "coding") return [];
	if (s.holdReason || s.monitorHealth !== "healthy" || s.stepId || !stopped(s))
		return ["wait", "inspect_more"];
	const actions = ["wait", "inspect_more", "escalate"];
	if (s.observation!.question) {
		if (
			s.observation!.question.kind === "local_repair" &&
			(s.blockerAttempts[blockerKey(s)] ?? 0) < 1 &&
			t.grant.operations.includes("edit")
		)
			actions.push("answer_question");
		return actions;
	}
	if (!s.observation!.snapshotHash) return actions;
	if (!checked(s)) {
		if (t.grant.operations.includes("check")) actions.push("run_checks");
		if (s.checks && s.repairLoops < 2 && t.grant.operations.includes("edit"))
			actions.push("request_change");
		return actions;
	}
	if (!reviewed(s)) {
		if (t.grant.operations.includes("review")) actions.push("request_review");
		if (s.review && s.repairLoops < 2 && t.grant.operations.includes("edit"))
			actions.push("request_change");
		return actions;
	}
	if (t.grant.operations.includes("commit") && !s.commit)
		return [...actions, "request_commit"];
	if (t.grant.operations.includes("push") && !s.push)
		return [...actions, "request_push"];
	if (
		s.checks!.conditionsMet.length === t.completionConditions.length &&
		s.checks!.conditionsMet.every(Boolean)
	)
		actions.push("finish_candidate");
	if (!s.checks!.conditionsMet.every(Boolean)) actions.push("fail_candidate");
	return actions;
}
export const operationFor: Record<
	StepKind,
	CodingWorkTask["grant"]["operations"][number]
> = {
	inspect_more: "read",
	answer_question: "edit",
	request_change: "edit",
	run_checks: "check",
	request_review: "review",
	request_commit: "commit",
	request_push: "push",
};
export const phaseFor: Record<StepKind, NonNullable<WorkTask["phase"]>> = {
	inspect_more: "preparing",
	answer_question: "implementing",
	request_change: "repairing",
	run_checks: "verifying",
	request_review: "reviewing",
	request_commit: "committing",
	request_push: "pushing",
};
export function validateReceipt(intent: StepIntent, r: StepReceipt) {
	if (
		r.operationId !== intent.id ||
		r.kind !== intent.kind ||
		!r.turnFinished ||
		!r.childrenStopped ||
		!r.evidenceComplete
	)
		throw new Error("supervision_step_unconfirmed");
	if (
		["run_checks", "request_review", "request_commit", "request_push"].includes(
			intent.kind,
		) &&
		(!intent.snapshotHash || r.snapshotHash !== intent.snapshotHash)
	)
		throw new Error("supervision_snapshot_conflict");
	if (
		intent.kind === "run_checks" &&
		(!r.checks ||
			r.checks.digest !== intent.policy.checksDigest ||
			r.checks.results.length !== intent.policy.checkIds.length ||
			new Set(r.checks.results.map((c) => c.id)).size !==
				intent.policy.checkIds.length ||
			!r.checks.results.every((c) => intent.policy.checkIds.includes(c.id)))
	)
		throw new Error("supervision_checks_changed");
	if (
		intent.kind === "request_review" &&
		(!r.review ||
			r.review.policyDigest !== intent.policy.reviewPolicyDigest ||
			!intent.implementationSessionId ||
			r.review.sessionId === intent.implementationSessionId)
	)
		throw new Error("supervision_review_not_independent");
	if (
		intent.kind === "request_commit" &&
		(!r.commit || r.commit.branch !== intent.branch)
	)
		throw new Error("supervision_commit_unconfirmed");
	if (
		intent.kind === "request_push" &&
		(!r.push ||
			r.push.branch !== intent.branch ||
			r.push.remote !== intent.remote)
	)
		throw new Error("supervision_push_unconfirmed");
}
export const digest = (v: unknown) => sha256Hex(canonicalJSON(v));
/**
 * Digest of what an observation means. Time, heartbeat position, the excerpt, how much of a body
 * was read (coverage) and the derived fact lines are excluded: reading more of the same evidence
 * must not expire an approval, a queued decision or a step. New speech, terminals, stops,
 * capture faults, snapshots, questions and failure codes do change it.
 */
export function semanticObservationDigest(o: Observation | null) {
	if (!o) return digest(null);
	const d = o.details;
	return digest({
		executionId: o.executionId,
		sessionId: o.sessionId,
		snapshotHash: o.snapshotHash,
		turnFinished: o.turnFinished,
		childrenStopped: o.childrenStopped,
		evidenceComplete: o.evidenceComplete,
		exitCode: o.exitCode,
		question: o.question,
		// Without details the fact lines are the only description of the run.
		facts: d ? null : o.facts,
		details: d
			? {
					run: d.run,
					processState: d.processState,
					messages: d.messages.map((m) => ({
						seq: m.seq,
						digest: m.digest,
						kind: m.metadata.messageKind,
						presence: m.metadata.contentPresence,
						truncated: m.metadata.sourceTruncated,
					})),
					publicReport:
						d.publicReport === "not_fully_observed" ? null : d.publicReport,
					finalReport: d.finalReport,
					// How much was read is coverage, not meaning.
					limitations: d.limitations
						.filter(
							(l) =>
								![
									"not_fully_observed",
									"context_excerpt_truncated",
									"messages_omitted",
									"evidence_unreadable",
								].includes(l),
						)
						.sort(),
					issue: d.issue,
				}
			: null,
	});
}
