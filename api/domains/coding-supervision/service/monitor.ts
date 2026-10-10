import type { Database } from "bun:sqlite";
import type { WorkTask } from "../../tasks";
import {
	observationSchema,
	type Observation,
	type ObservationFailure,
	type Supervisor,
} from "../contracts";
import * as repo from "../repository";
import { digest, live, semanticObservationDigest, stopped } from "./policy";
import type { createApproval } from "./approval";
import type { SupervisionContext } from "./context";
import type { createLifecycle } from "./lifecycle";
import type { Holds } from "./holds";
import {
	diagnosticCode,
	transientCodes,
	type Diagnostics,
} from "./diagnostics";

/** Reacts to task changes and CLI observations; owns recovery and maintenance sweeps. */
export function createMonitor(
	ctx: SupervisionContext,
	deps: {
		lifecycle: ReturnType<typeof createLifecycle>;
		holds: Holds;
		approval: ReturnType<typeof createApproval>;
		diagnostics: Diagnostics;
		capture: (db: Database, t: WorkTask, s: Supervisor) => void;
	},
) {
	const { store, tasks, reports, now, report } = ctx;
	const { invalidate, ensure } = deps.lifecycle;
	const { hold } = deps.holds;
	const { approval, capture, diagnostics } = deps;
	return {
		initializeInTransaction: ensure,
		taskChangedInTransaction(db: Database, t: WorkTask) {
			const s = repo.get(db, t.id);
			if (!s) return;
			if (t.bodyExpired || t.forgottenAt) {
				invalidate(db, s);
				repo.purge(db, t.id);
				reports.purgeInTransaction(db, t.id);
				return;
			}
			if (
				!live(t, now()) ||
				t.executionGeneration !== s.generation ||
				t.authorityEpoch !== s.authorityEpoch ||
				(s.decisionId !== null &&
					repo.decision(db, s.decisionId)?.fence.expectedRevision !==
						t.revision) ||
				(s.stepId !== null &&
					repo.step(db, s.stepId)?.intent.revision !== t.revision)
			) {
				invalidate(db, s);
				repo.put(db, s);
			}
			if (t.state === "queued")
				reports.supersedeQuestionsInTransaction(db, t.id);
			if (t.state === "cancelled" || t.state === "paused")
				report(
					db,
					t,
					s,
					t.state,
					t.state === "cancelled"
						? "タスクの取消を確認しました。"
						: "タスクの一時停止を確認しました。",
					t.state,
				);
		},
		observeInTransaction(
			db: Database,
			taskId: string,
			raw: Observation,
			source: "tick" | "diagnostic" = "tick",
		) {
			const t = tasks().getInTransaction(db, taskId);
			// A host diagnosis may complete while the task is reconciling after a failed adoption.
			if (
				ctx.state.closed ||
				!t ||
				!live(t, now()) ||
				!(
					t.state === "active" ||
					(source === "diagnostic" && t.state === "reconciling")
				)
			)
				return;
			const parsed = observationSchema.parse(raw),
				s = ensure(db, t);
			// A host re-read of stored facts does not repair a failed adoption: carry the failure
			// code and the last good cursor into the observation instead of hiding them.
			const issue = source === "diagnostic" ? s.observationIssue : null;
			const o: Observation =
				issue && parsed.details
					? {
							...parsed,
							facts: [
								`観測障害: ${issue.code}(最後の正常cursor: ${issue.lastCursor ?? "不明"}。以降は未確認)`,
								...parsed.facts,
							].slice(0, 8),
							details: { ...parsed.details, issue: issue.code },
						}
					: parsed;
			// A slower read that finishes after a newer one must not move the view backwards.
			if (
				s.observation?.executionId === o.executionId &&
				o.eventSeq < s.observation.eventSeq
			)
				return;
			const fingerprint = digest({
				epoch: t.authorityEpoch,
				generation: t.executionGeneration,
				phase: t.phase,
				observation: semanticObservationDigest(o),
			});
			if (source === "tick") {
				s.lastObservedAt = now();
				s.nextCheckAt = now() + 60_000;
				s.failures = 0;
				s.monitorHealth = "healthy";
				s.observationIssue = null;
				if (s.holdReason === "supervision_monitoring_delayed")
					s.holdReason = null;
			}
			if (s.fingerprint !== fingerprint) {
				if (s.decisionId) invalidate(db, s);
				if (s.stepId) {
					const step = repo.step(db, s.stepId);
					if (
						step?.status === "pending" &&
						semanticObservationDigest(o) !== step.intent.observationDigest
					)
						invalidate(db, s);
				}
				if (s.observation?.snapshotHash !== o.snapshotHash) {
					s.checks = null;
					s.review = null;
					s.commit = null;
					s.push = null;
				}
				s.fingerprint = fingerprint;
				s.observation = o;
				s.lastProgressAt = now();
				repo.observe(db, s, now());
			} else {
				// Same meaning: keep the newest excerpt and coverage without a new judgement.
				s.observation = o;
			}
			if (
				s.lastReportFingerprint !== fingerprint &&
				(s.lastReportAt === null ||
					now() - s.lastReportAt >= t.grant.progressIntervalMs)
			) {
				report(
					db,
					t,
					s,
					"progress",
					"CLIの実行状況に変化がありました。",
					`progress:${fingerprint}`,
				);
				s.lastReportAt = now();
				s.lastReportFingerprint = fingerprint;
			}
			// A rejected approval asks the user a new question: `t` is stale, so do not capture.
			const taskChanged = approval.resolve(db, t, s);
			if (
				!taskChanged &&
				t.state === "active" &&
				!s.stepId &&
				!s.decisionId &&
				s.handledFingerprint !== fingerprint &&
				stopped(s) &&
				!s.holdReason
			)
				capture(db, t, s);
			repo.put(db, s);
			// A non-ok run is looked at again by the host, not by the decision model.
			if (source === "diagnostic") diagnostics.afterDiagnosticRead(db, t, s);
			else if (
				diagnosticCode(s) &&
				s.diagnostics?.requestedFor !== fingerprint &&
				!taskChanged
			) {
				s.diagnostics = {
					...(s.diagnostics ?? {
						scope: "",
						total: 0,
						codes: {},
						activeId: null,
					}),
					requestedFor: fingerprint,
				};
				diagnostics.request(db, t, s, diagnosticCode(s)!);
			}
		},
		observationFailedInTransaction(
			db: Database,
			taskId: string,
			failure?: ObservationFailure,
		) {
			const t = tasks().getInTransaction(db, taskId);
			if (!t || !live(t, now())) return;
			// A failure that belongs to an older generation or authority says nothing about this run.
			if (
				failure &&
				(failure.generation !== t.executionGeneration ||
					failure.authorityEpoch !== t.authorityEpoch)
			)
				return;
			const s = ensure(db, t);
			if (failure) {
				s.observationIssue = {
					code: failure.code,
					executionId: failure.executionId,
					lastCursor: failure.lastCursor,
					at: now(),
				};
				if (!transientCodes.has(failure.code))
					diagnostics.request(db, t, s, failure.code);
			}
			s.failures++;
			s.nextCheckAt = now() + 60_000;
			if (
				s.failures >= 2 ||
				(s.lastObservedAt !== null && now() - s.lastObservedAt >= 150_000)
			) {
				s.monitorHealth = "monitoring_delayed";
				invalidate(db, s);
				// A fixed-code hold from a finished diagnosis is not replaced by the generic one.
				if (!s.diagnostics?.blocked)
					hold(db, t, s, "supervision_monitoring_delayed");
			}
			repo.put(db, s);
		},
		/** A fixed-code hold decided by the host (e.g. an unsupported continue); one report. */
		holdFixedInTransaction(db: Database, taskId: string, code: string) {
			const t = tasks().getInTransaction(db, taskId);
			if (!t || !live(t, now())) return;
			const s = ensure(db, t);
			invalidate(db, s);
			hold(db, t, s, code);
			repo.put(db, s);
		},
		async recover() {
			await store.write((db) => {
				for (const s of repo.all(db)) {
					const t = tasks().getInTransaction(db, s.taskId);
					invalidate(db, s);
					// A read that was in flight when the process stopped is not resumed or refunded.
					if (s.diagnostics) s.diagnostics.activeId = null;
					if (t?.bodyExpired) {
						repo.purge(db, s.taskId);
						reports.purgeInTransaction(db, s.taskId);
					} else {
						if (t && live(t, now()))
							hold(db, t, s, "supervision_recovery_requires_receipts");
						repo.put(db, s);
					}
				}
			});
		},
		async maintenance() {
			await store.write((db) => {
				for (const t of tasks().liveInTransaction(db)) {
					const s = repo.get(db, t.id);
					if (!s) continue;
					if (
						live(t, now()) &&
						(s.lastObservedAt !== null
							? now() - s.lastObservedAt >= 150_000
							: now() >= s.nextCheckAt + 90_000) &&
						s.monitorHealth !== "monitoring_delayed"
					) {
						s.monitorHealth = "monitoring_delayed";
						invalidate(db, s);
						// A fixed-code hold from a finished diagnosis is not replaced by the generic one.
						if (!s.diagnostics?.blocked)
							hold(db, t, s, "supervision_monitoring_delayed");
						repo.put(db, s);
					}
				}
			});
		},
	};
}
