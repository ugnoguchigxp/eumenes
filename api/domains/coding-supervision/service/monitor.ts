import type { Database } from "bun:sqlite";
import type { WorkTask } from "../../tasks";
import {
	observationSchema,
	type Observation,
	type Supervisor,
} from "../contracts";
import * as repo from "../repository";
import { digest, live, stopped } from "./policy";
import type { createApproval } from "./approval";
import type { SupervisionContext } from "./context";
import type { createLifecycle } from "./lifecycle";
import type { Holds } from "./holds";

/** Reacts to task changes and CLI observations; owns recovery and maintenance sweeps. */
export function createMonitor(
	ctx: SupervisionContext,
	deps: {
		lifecycle: ReturnType<typeof createLifecycle>;
		holds: Holds;
		approval: ReturnType<typeof createApproval>;
		capture: (db: Database, t: WorkTask, s: Supervisor) => void;
	},
) {
	const { store, tasks, reports, now, report } = ctx;
	const { invalidate, ensure } = deps.lifecycle;
	const { hold } = deps.holds;
	const { approval, capture } = deps;
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
		observeInTransaction(db: Database, taskId: string, raw: Observation) {
			const t = tasks().getInTransaction(db, taskId);
			if (ctx.state.closed || !t || !live(t, now()) || t.state !== "active")
				return;
			const o = observationSchema.parse(raw),
				s = ensure(db, t),
				fingerprint = digest({
					epoch: t.authorityEpoch,
					generation: t.executionGeneration,
					phase: t.phase,
					observation: o,
				});
			s.lastObservedAt = now();
			s.nextCheckAt = now() + 60_000;
			s.failures = 0;
			s.monitorHealth = "healthy";
			if (s.holdReason === "supervision_monitoring_delayed")
				s.holdReason = null;
			if (s.fingerprint !== fingerprint) {
				if (s.decisionId) invalidate(db, s);
				if (s.stepId) {
					const step = repo.step(db, s.stepId);
					if (
						step?.status === "pending" &&
						digest(o) !== step.intent.observationDigest
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
				!s.stepId &&
				!s.decisionId &&
				s.handledFingerprint !== fingerprint &&
				stopped(s) &&
				!s.holdReason
			)
				capture(db, t, s);
			repo.put(db, s);
		},
		observationFailedInTransaction(db: Database, taskId: string) {
			const t = tasks().getInTransaction(db, taskId);
			if (!t || !live(t, now())) return;
			const s = ensure(db, t);
			s.failures++;
			s.nextCheckAt = now() + 60_000;
			if (
				s.failures >= 2 ||
				(s.lastObservedAt !== null && now() - s.lastObservedAt >= 150_000)
			) {
				s.monitorHealth = "monitoring_delayed";
				invalidate(db, s);
				hold(db, t, s, "supervision_monitoring_delayed");
			}
			repo.put(db, s);
		},
		async recover() {
			await store.write((db) => {
				for (const s of repo.all(db)) {
					const t = tasks().getInTransaction(db, s.taskId);
					invalidate(db, s);
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
				for (const s of repo.all(db)) {
					const t = tasks().getInTransaction(db, s.taskId);
					if (
						t &&
						live(t, now()) &&
						(s.lastObservedAt !== null
							? now() - s.lastObservedAt >= 150_000
							: now() >= s.nextCheckAt + 90_000) &&
						s.monitorHealth !== "monitoring_delayed"
					) {
						s.monitorHealth = "monitoring_delayed";
						invalidate(db, s);
						hold(db, t, s, "supervision_monitoring_delayed");
						repo.put(db, s);
					}
				}
			});
		},
	};
}
