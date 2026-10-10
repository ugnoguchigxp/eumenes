import type { Database } from "bun:sqlite";
import type { WorkTask } from "../../tasks";
import type { Supervisor } from "../contracts";
import * as repo from "../repository";
import type { SupervisionContext } from "./context";

/** Supervisor row creation and invalidation of its in-flight decision and step. */
export function createLifecycle(ctx: SupervisionContext) {
	const { queue, inference, now, cancelledJobs, cancelledRequests } = ctx;
	function invalidate(db: Database, s: Supervisor) {
		if (s.decisionId) {
			const r = repo.decision(db, s.decisionId);
			if (r?.status === "pending") {
				r.status = "superseded";
				repo.putDecision(db, r);
				queue.cancelInTransaction(db, r.jobId, "supervision_superseded");
				cancelledJobs.add(r.jobId);
				inference.cancelRequestsInTransaction?.(db, [r.requestId]);
				cancelledRequests.add(r.requestId);
			}
			s.decisionId = null;
		}
		if (s.stepId) {
			const r = repo.step(db, s.stepId);
			if (r && ["pending", "running"].includes(r.status)) {
				r.status = r.status === "running" ? "outcome_unknown" : "superseded";
				repo.putStep(db, r);
				queue.cancelInTransaction(db, r.jobId, "supervision_superseded");
				cancelledJobs.add(r.jobId);
			}
			s.stepId = null;
		}
	}
	function ensure(db: Database, t: WorkTask): Supervisor {
		const old = repo.get(db, t.id);
		if (
			old &&
			old.generation === t.executionGeneration &&
			old.authorityEpoch === t.authorityEpoch
		)
			return old;
		if (old) invalidate(db, old);
		const s: Supervisor = {
			taskId: t.id,
			generation: t.executionGeneration,
			authorityEpoch: t.authorityEpoch,
			lastObservedAt: null,
			lastProgressAt: null,
			nextCheckAt: now() + 60_000,
			monitorHealth: "healthy",
			failures: 0,
			fingerprint: null,
			handledFingerprint: null,
			observation: null,
			decisionId: null,
			stepId: null,
			checks: null,
			review: null,
			commit: null,
			push: null,
			decisionsUsed: old?.decisionsUsed ?? 0,
			repairLoops: old?.repairLoops ?? 0,
			blockerAttempts: old?.blockerAttempts ?? {},
			lastReportAt: null,
			lastReportFingerprint: null,
			holdReason: null,
		};
		repo.put(db, s);
		return s;
	}
	return { invalidate, ensure };
}
