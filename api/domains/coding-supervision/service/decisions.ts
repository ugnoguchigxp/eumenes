import type { Database } from "bun:sqlite";
import type { HandlerDefinition } from "../../queue";
import type { Receipt } from "../../inference/contracts";
import type { WorkTask } from "../../tasks";
import {
	decisionSchema,
	observationSchema,
	type Decision,
	type Supervisor,
} from "../contracts";
import * as repo from "../repository";
import { allowedActions, digest, fence, live } from "./policy";
import { messages } from "./prompt";
import { payloadSchema, type SupervisionContext } from "./context";
import type { Holds } from "./holds";

/** Captures a background model decision for a stopped task and settles its result. */
export function createDecisions(
	ctx: SupervisionContext,
	deps: {
		holds: Holds;
		apply: (db: Database, t: WorkTask, s: Supervisor, d: Decision) => void;
	},
) {
	const { tasks, queue, inference, workflow, now, cancelledRequests } = ctx;
	const { hold, escalate } = deps.holds;
	const { apply } = deps;
	function current(db: Database, r: repo.DecisionRecord) {
		const t = tasks().getInTransaction(db, r.taskId),
			s = repo.get(db, r.taskId);
		if (
			ctx.state.closed ||
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
	return { capture, handler: decisionHandler };
}
