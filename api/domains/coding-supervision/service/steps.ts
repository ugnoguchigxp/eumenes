import type { Database } from "bun:sqlite";
import type { HandlerDefinition } from "../../queue";
import type { WorkTask } from "../../tasks";
import {
	stepReceiptSchema,
	type StepIntent,
	type StepReceipt,
	type Supervisor,
} from "../contracts";
import * as repo from "../repository";
import { digest, live, validateReceipt } from "./policy";
import { payloadSchema, type SupervisionContext } from "./context";
import type { Holds } from "./holds";

/** Runs the queued CLI step through the workflow port and adopts its verified receipt. */
export function createSteps(ctx: SupervisionContext, deps: { holds: Holds }) {
	const { tasks, reports, workflow, now, report } = ctx;
	const { hold } = deps.holds;
	function adopt(db: Database, t: WorkTask, s: Supervisor, r: StepReceipt) {
		if (r.kind === "run_checks") {
			s.checks = r;
			s.review = null;
			s.commit = null;
			s.push = null;
		}
		if (r.kind === "request_review") {
			s.review = r;
			s.commit = null;
			s.push = null;
		}
		if (r.kind === "request_commit") s.commit = r;
		if (r.kind === "request_push") {
			if (r.push!.sha !== s.commit?.commit?.sha)
				throw new Error("supervision_push_sha_conflict");
			s.push = r;
		}
		if (["request_change", "answer_question"].includes(r.kind)) {
			s.checks = null;
			s.review = null;
			s.commit = null;
			s.push = null;
			reports.supersedeQuestionsInTransaction(db, t.id);
		}
		s.handledFingerprint = null;
		report(
			db,
			t,
			s,
			"progress",
			`${t.phase ?? "実装"}の実行結果を確認しました。`,
			`step:${r.operationId}`,
		);
	}
	function stepCurrent(db: Database, r: repo.StepRecord) {
		const t = tasks().getInTransaction(db, r.intent.taskId),
			s = repo.get(db, r.intent.taskId);
		if (
			ctx.state.closed ||
			!t ||
			!s ||
			!live(t, now()) ||
			t.state !== "active" ||
			t.revision !== r.intent.revision ||
			t.executionGeneration !== r.intent.generation ||
			t.authorityEpoch !== r.intent.authorityEpoch ||
			s.stepId !== r.intent.id ||
			s.monitorHealth !== "healthy" ||
			s.holdReason ||
			s.observation?.snapshotHash !== r.intent.snapshotHash ||
			digest(s.observation) !== r.intent.observationDigest
		)
			return null;
		return { t, s };
	}
	const stepHandler: HandlerDefinition<
		{ id: string },
		StepIntent,
		StepReceipt
	> = {
		kind: "coding-supervision.step.v1",
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "interrupt",
		prepareInTransaction(db, c) {
			const r = repo.step(db, c.payload.id);
			if (
				!r ||
				r.status !== "pending" ||
				!stepCurrent(db, r) ||
				!workflow.available() ||
				digest(workflow.policy(r.intent.taskId)) !== digest(r.intent.policy)
			) {
				if (r?.status === "pending") {
					r.status = "superseded";
					repo.putStep(db, r);
					const s = repo.get(db, r.intent.taskId),
						t = tasks().getInTransaction(db, r.intent.taskId);
					if (s?.stepId === r.intent.id) {
						s.stepId = null;
						if (t && live(t, now()) && !ctx.state.closed)
							hold(db, t, s, "supervision_step_preparation_stale");
						repo.put(db, s);
					}
				}
				return { status: "stale", reason: "supervision_step_stale" };
			}
			r.status = "running";
			repo.putStep(db, r);
			return { status: "ready", input: r.intent };
		},
		async execute(intent, c) {
			const receipt = stepReceiptSchema.parse(
				await workflow.execute(intent, c.signal),
			);
			validateReceipt(intent, receipt);
			return receipt;
		},
		settleInTransaction(db, c, _intent, outcome) {
			const r = repo.step(db, c.payload.id);
			if (r?.status === "pending" && outcome.type !== "success") {
				r.status = "superseded";
				repo.putStep(db, r);
				const s = repo.get(db, r.intent.taskId),
					t = tasks().getInTransaction(db, r.intent.taskId);
				if (s?.stepId === r.intent.id) {
					s.stepId = null;
					if (t && live(t, now()))
						hold(db, t, s, "supervision_step_not_started");
					repo.put(db, s);
				}
				return "applied";
			}
			if (!r || r.status !== "running") return "stale";
			const current = stepCurrent(db, r);
			if (!current) {
				r.status = "outcome_unknown";
				repo.putStep(db, r);
				const s = repo.get(db, r.intent.taskId),
					t = tasks().getInTransaction(db, r.intent.taskId);
				if (s?.stepId === r.intent.id) {
					s.stepId = null;
					if (t && live(t, now()))
						hold(db, t, s, "supervision_step_stale_receipt");
					repo.put(db, s);
				}
				return "stale";
			}
			const { t, s } = current;
			s.stepId = null;
			if (outcome.type === "success") {
				try {
					validateReceipt(r.intent, outcome.result);
					adopt(db, t, s, outcome.result);
					r.status = "applied";
				} catch {
					r.status = "outcome_unknown";
					hold(db, t, s, "supervision_step_unconfirmed");
				}
			} else {
				r.status = "outcome_unknown";
				hold(db, t, s, "supervision_step_outcome_unknown");
			}
			repo.putStep(db, r);
			repo.put(db, s);
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = repo.step(db, job.payload.id);
			if (!r || !["pending", "running"].includes(r.status)) return;
			r.status = r.status === "running" ? "outcome_unknown" : "superseded";
			repo.putStep(db, r);
			const s = repo.get(db, r.intent.taskId),
				t = tasks().getInTransaction(db, r.intent.taskId);
			if (s?.stepId === r.intent.id) {
				s.stepId = null;
				if (t && live(t, now())) hold(db, t, s, "supervision_step_cancelled");
				repo.put(db, s);
			}
		},
	};
	return { handler: stepHandler };
}
