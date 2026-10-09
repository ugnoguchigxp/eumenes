import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { TasksService, WorkTask } from "../../tasks";
import type { QueueService, HandlerDefinition } from "../../queue";
import type { InferencePort, Receipt } from "../../inference/contracts";
import type { TaskReports, ReportBody } from "../../task-reports";
import { canonicalJSON } from "../../../../packages/coding-runner/src/contracts";
import {
	decisionSchema,
	observationSchema,
	stepReceiptSchema,
	stepKinds,
	type Supervisor,
	type WorkflowPort,
	type Observation,
	type Decision,
	type StepIntent,
	type StepReceipt,
	type StepKind,
} from "../contracts";
import * as repo from "../repository";
import {
	allowedActions,
	fence,
	live,
	stopped,
	checked,
	reviewed,
	operationFor,
	phaseFor,
	validateReceipt,
	blockerKey,
} from "./policy";
import { messages } from "./prompt";
const payloadSchema = z.strictObject({ id: z.string().min(1).max(160) });
const digest = (v: unknown) =>
	new Bun.CryptoHasher("sha256").update(canonicalJSON(v)).digest("hex");
export function createCodingSupervision(input: {
	store: SqliteStore;
	tasks: () => TasksService;
	queue: QueueService;
	inference: InferencePort;
	reports: TaskReports;
	workflow: WorkflowPort;
	now?: () => number;
}) {
	const { store, queue, inference, reports, workflow } = input,
		now = input.now ?? Date.now,
		tasks = input.tasks;
	const cancelledJobs = new Set<string>(),
		cancelledRequests = new Set<string>();
	let closed = false;
	function report(
		db: Database,
		t: WorkTask,
		s: Supervisor,
		kind: ReportBody["kind"],
		summary: string,
		key: string,
	) {
		return reports.appendInTransaction(
			db,
			t.id,
			`${t.executionGeneration}:${t.authorityEpoch}:${key}`,
			{
				kind,
				summary,
				facts: (kind === "cancelled" || kind === "paused"
					? [`確認済みのタスク状態: ${t.state}`]
					: (s.observation?.facts ?? [])
				)
					.slice(0, 6)
					.map((f) => f.slice(0, 300)),
				limitations: s.holdReason ? [s.holdReason] : [],
				git:
					s.commit || s.push
						? {
								commitSha: s.commit?.commit?.sha ?? null,
								remoteSha: s.push?.push?.sha ?? null,
								branch:
									s.commit?.commit?.branch ?? s.push?.push?.branch ?? null,
								remote: s.push?.push?.remote ?? null,
							}
						: null,
				evidenceRefs: evidence(s),
				snapshotHash: s.observation?.snapshotHash ?? null,
				questionId:
					kind === "blocker"
						? (tasks().openQuestionInTransaction(db, t.id)?.id ?? null)
						: null,
			},
			s.lastObservedAt ?? now(),
		);
	}
	function evidence(s: Supervisor) {
		return [
			...new Set([
				...[s.checks, s.review, s.commit, s.push].flatMap((r) =>
					r?.evidenceRefs[0] ? [r.evidenceRefs[0]] : [],
				),
				...(s.observation?.evidenceRefs ?? []),
				...[s.checks, s.review, s.commit, s.push].flatMap(
					(r) => r?.evidenceRefs ?? [],
				),
			]),
		].slice(0, 20);
	}
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
	function current(db: Database, r: repo.DecisionRecord) {
		const t = tasks().getInTransaction(db, r.taskId),
			s = repo.get(db, r.taskId);
		if (
			closed ||
			!t ||
			!s ||
			!live(t, now()) ||
			t.state !== "active" ||
			t.revision !== r.fence.expectedRevision ||
			t.authorityEpoch !== r.fence.authorityEpoch ||
			t.executionGeneration !== r.fence.executionGeneration ||
			t.phase !== r.phase ||
			s.fingerprint !== r.fingerprint ||
			s.monitorHealth !== "healthy" ||
			s.holdReason ||
			s.decisionId !== r.id
		)
			return null;
		return { t, s };
	}
	function hold(db: Database, t: WorkTask, s: Supervisor, reason: string) {
		if (s.holdReason === reason) return;
		s.holdReason = reason;
		report(
			db,
			t,
			s,
			"monitoring_issue",
			"監督の処理を停止しました。状況の確認が必要です。",
			`hold:${reason}:${s.fingerprint ?? "initial"}`,
		);
	}
	function escalate(db: Database, t: WorkTask, s: Supervisor, reason: string) {
		if (!stopped(s)) {
			hold(db, t, s, "supervision_stop_unconfirmed");
			return;
		}
		const questionId = `supervision:${t.id}:${crypto.randomUUID()}`;
		tasks().askInTransaction(db, fence(t), {
			questionId,
			prompt: reason.slice(0, 2000),
			answerType: "text",
			choices: [],
		});
		const updated = tasks().getInTransaction(db, t.id)!;
		report(
			db,
			updated,
			s,
			"blocker",
			reason.slice(0, 600),
			`blocker:${questionId}`,
		);
	}
	function capture(
		db: Database,
		t: WorkTask,
		s: Supervisor,
		repair = 0,
		deadline?: number,
	) {
		if (s.decisionsUsed >= t.grant.maxDecisions) {
			escalate(
				db,
				t,
				s,
				"監督の判断回数が上限に達しました。続行方針を指定してください。",
			);
			return;
		}
		const id = crypto.randomUUID(),
			end =
				deadline ??
				Math.min(
					now() + 30_000,
					Date.parse(t.grant.expiresAt),
					Date.parse(t.executionDeadlineAt!),
				);
		const context = messages(t, s, allowedActions(t, s));
		if (repair)
			context.push({
				role: "user",
				content:
					"The previous output was not valid JSON for the required schema. Return one valid object. Do not change permissions or invent evidence.",
			});
		const count = inference.countControlTokens?.(context) ?? null;
		if (count === null) {
			hold(db, t, s, "model_tokenizer_unavailable");
			return;
		}
		if (
			!Number.isSafeInteger(count) ||
			count > 12000 ||
			count < 0 ||
			new TextEncoder().encode(JSON.stringify(context)).length > 128 * 1024
		) {
			hold(db, t, s, "supervision_context_exceeded");
			return;
		}
		if (
			!inference.captureBackgroundControlInTransaction ||
			!inference.executeControl ||
			!inference.acceptInTransaction ||
			!inference.cancelRequestsInTransaction ||
			!inference.flushCancelledRequests ||
			!inference.rejectControlInTransaction
		) {
			hold(db, t, s, "background_inference_unavailable");
			return;
		}
		if (end <= now()) {
			hold(db, t, s, "supervision_decision_timeout");
			return;
		}
		const requestId = inference.captureBackgroundControlInTransaction(db, {
			taskId: t.id,
			decisionId: id,
			authorityEpoch: t.authorityEpoch,
			executionGeneration: t.executionGeneration,
			deadline: end,
			taskDeadline: Math.min(
				Date.parse(t.grant.expiresAt),
				Date.parse(t.executionDeadlineAt!),
			),
			maxOutputTokens: 1500,
		});
		const { job } = queue.enqueueInTransaction(db, {
			scope: `supervision:${t.id}`,
			kind: "coding-supervision.decide.v1",
			payload: { id },
			dedupeKey: id,
			subjectRef: t.id,
			lane: "background",
			resourceKey: "inference.llm",
			concurrencyKey: `supervision:${t.id}:decision`,
			deadlineAtMs: end,
			maxAttempts: 1,
		});
		repo.putDecision(db, {
			id,
			taskId: t.id,
			status: "pending",
			fence: fence(t),
			phase: t.phase,
			fingerprint: s.fingerprint!,
			observationDigest: digest(s.observation),
			requestId,
			deadline: end,
			repair,
			inputTokenCount: count,
			jobId: job.id,
			messages: context,
			proposal: null,
		});
		s.decisionsUsed++;
		s.decisionId = id;
	}
	function apply(db: Database, t: WorkTask, s: Supervisor, d: Decision) {
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
			s.blockerAttempts[blockerKey(s)] =
				(s.blockerAttempts[blockerKey(s)] ?? 0) + 1;
		}
		if (kind === "request_change") {
			if (s.repairLoops >= 2) {
				escalate(db, t, s, "修正回数の上限に達しました。");
				return;
			}
			s.repairLoops++;
		}
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
			instruction: d.instruction,
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
	const decisionHandler: HandlerDefinition<
		{ id: string },
		repo.DecisionRecord,
		{ receipt: Receipt; decision: Decision | null; observationDigest: string }
	> = {
		kind: "coding-supervision.decide.v1",
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const r = repo.decision(db, claim.payload.id);
			return r?.status === "pending" && current(db, r)
				? { status: "ready", input: r }
				: { status: "stale", reason: "supervision_stale" };
		},
		async execute(r, c) {
			const signal = AbortSignal.any([
				c.signal,
				AbortSignal.timeout(Math.max(1, r.deadline - now())),
			]);
			const receipt = await inference.executeControl!(
				r.requestId,
				r.messages,
				signal,
			);
			const fresh = observationSchema.parse(
				await workflow.observe(r.taskId, signal),
			);
			signal.throwIfAborted();
			let parsed: unknown;
			try {
				if (
					typeof receipt.value === "string" &&
					new TextEncoder().encode(receipt.value).length <= 16384
				)
					parsed = JSON.parse(receipt.value);
			} catch {}
			const d = decisionSchema.safeParse(parsed);
			return {
				receipt,
				decision: d.success ? d.data : null,
				observationDigest: digest(fresh),
			};
		},
		settleInTransaction(db, claim, _r, outcome) {
			const r = repo.decision(db, claim.payload.id);
			if (!r || r.status !== "pending") return "stale";
			const c = current(db, r);
			if (!c) {
				r.status = "superseded";
				repo.putDecision(db, r);
				inference.cancelRequestsInTransaction?.(db, [r.requestId]);
				cancelledRequests.add(r.requestId);
				return "stale";
			}
			const { t, s } = c;
			s.decisionId = null;
			s.handledFingerprint = s.fingerprint;
			if (
				outcome.type !== "success" ||
				outcome.result.receipt.requestId !== r.requestId
			) {
				r.status = "failed";
				hold(db, t, s, "supervision_decision_unconfirmed");
				inference.cancelRequestsInTransaction?.(db, [r.requestId]);
				cancelledRequests.add(r.requestId);
			} else if (outcome.result.observationDigest !== r.observationDigest) {
				r.status = "superseded";
				s.handledFingerprint = null;
				inference.rejectControlInTransaction!(
					db,
					outcome.result.receipt,
					"supervision_observation_changed",
				);
			} else if (!outcome.result.decision) {
				inference.rejectControlInTransaction!(
					db,
					outcome.result.receipt,
					"invalid_supervision_json",
				);
				r.status = "failed";
				if (r.repair === 0) capture(db, t, s, 1, r.deadline);
				else
					escalate(
						db,
						t,
						s,
						"監督の応答を解析できませんでした。続行方針の確認が必要です。",
					);
			} else if (!inference.acceptInTransaction!(db, outcome.result.receipt)) {
				r.status = "superseded";
				hold(db, t, s, "supervision_inference_revoked");
			} else {
				r.status = "applied";
				r.proposal = outcome.result.decision;
				repo.putDecision(db, r);
				repo.put(db, s);
				apply(db, t, s, r.proposal);
			}
			repo.putDecision(db, r);
			repo.put(db, s);
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = repo.decision(db, job.payload.id);
			if (!r || r.status !== "pending") return;
			r.status = "superseded";
			repo.putDecision(db, r);
			inference.cancelRequestsInTransaction?.(db, [r.requestId]);
			cancelledRequests.add(r.requestId);
			const s = repo.get(db, r.taskId);
			if (s?.decisionId === r.id) {
				s.decisionId = null;
				repo.put(db, s);
			}
		},
	};
	function stepCurrent(db: Database, r: repo.StepRecord) {
		const t = tasks().getInTransaction(db, r.intent.taskId),
			s = repo.get(db, r.intent.taskId);
		if (
			closed ||
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
						if (t && live(t, now()) && !closed)
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
	queue.registerHandler(decisionHandler);
	queue.registerHandler(stepHandler);
	const unsubscribe = store.onCommit(() => {
		for (const id of cancelledJobs) {
			queue.flushCancellations([id]);
		}
		cancelledJobs.clear();
		if (cancelledRequests.size)
			inference.flushCancelledRequests?.([...cancelledRequests]);
		cancelledRequests.clear();
		queue.wake();
	});
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
			if (closed || !t || !live(t, now()) || t.state !== "active") return;
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
			if (
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
		get(taskId: string) {
			return store.readSnapshot((db) => {
				const t = tasks().getInTransaction(db, taskId);
				if (!t) throw new Error("task_not_found");
				if (t.bodyExpired) throw new Error("task_history_expired");
				const s = repo.get(db, taskId);
				if (!s) return null;
				const {
					observation: _o,
					checks: _c,
					review: _r,
					commit: _g,
					push: _p,
					blockerAttempts: _b,
					...view
				} = s;
				return {
					...view,
					diagnosticDue:
						live(t, now()) &&
						s.lastProgressAt !== null &&
						now() - s.lastProgressAt >= 300_000,
				};
			});
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
		close() {
			if (closed) return;
			closed = true;
			unsubscribe();
		},
	};
}
export type CodingSupervision = ReturnType<typeof createCodingSupervision>;
