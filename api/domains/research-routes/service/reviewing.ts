import type { Database } from "bun:sqlite";
import type { HandlerDefinition } from "../../queue";
import type { Messages, Receipt } from "../../inference/contracts";
import {
	type JobPayload,
	jobKinds,
	jobPayload,
	limits,
	reviewOutput,
} from "../contracts";
import * as repo from "../repository";
import { renderDraft, reviewInstructions } from "./assets";
import { parseJson, receiptText } from "./authoring";
import {
	type FlowDeps,
	draftContext,
	endDraft,
	enqueueStep,
	safe,
	stepDeadline,
	stopReason,
	subjectOf,
} from "./flow";
import type { Registration } from "./registration";

type Input = { draftId: string; requestId: string; messages: Messages };
type Output = { receipt: Receipt };
export const reviewStepFor = (draft: repo.DraftRow) =>
	draft.corrections === 0 ? "review-1" : "review-2";

export function createReviewHandler(
	deps: FlowDeps,
	registration: Pick<Registration, "activateInTransaction">,
): HandlerDefinition<JobPayload, Input, Output> {
	const { clock } = deps;
	/** Rebuild what the reviewer sees from the ledger; null if the stored draft is unusable. */
	function rendered(db: Database, draft: repo.DraftRow) {
		const ctx = draftContext(db, draft);
		if (!ctx || !draft.skill_draft) return null;
		const stored = JSON.parse(draft.skill_draft) as {
			author: Parameters<typeof renderDraft>[0];
			digest: string;
		};
		const r = renderDraft(
			stored.author,
			ctx.spec,
			ctx.recipe,
			draft.base_version_id,
		);
		return r.digest === stored.digest ? { ctx, stored, r } : null;
	}
	return {
		kind: jobKinds.review,
		payloadVersions: [1],
		schema: jobPayload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const draft = repo.getDraft(db, claim.payload.draftId);
			if (
				!draft ||
				draft.state !== "reviewing" ||
				reviewStepFor(draft) !== claim.payload.step
			)
				return { status: "stale", reason: "draft_not_reviewing" };
			const view = rendered(db, draft);
			const stop = stopReason(db, deps, draft, view?.ctx ?? null);
			if (stop) {
				endDraft(db, clock, draft, stop.to, stop.code);
				return { status: "stale", reason: stop.code };
			}
			if (!view) {
				endDraft(db, clock, draft, "rejected", "digest_mismatch");
				return { status: "stale", reason: "digest_mismatch" };
			}
			let requestId: string;
			try {
				requestId = deps.inference.captureMaintenanceControlInTransaction(db, {
					subject: subjectOf(draft.id, claim.payload.step),
					deadline: stepDeadline(clock, draft),
					maxOutputTokens: limits.controlMaxTokens,
				});
			} catch {
				endDraft(db, clock, draft, "rejected", "maintenance_unavailable");
				return { status: "stale", reason: "maintenance_unavailable" };
			}
			const a = view.stored.author;
			const payload = {
				task: "review",
				draftDigest: view.r.digest,
				draft: {
					name: a.name,
					description: a.description,
					body: a.body,
					contextRule: a.contextRule,
					skill: view.r.skill,
					context: view.r.context,
				},
				spec: view.ctx.spec,
				recipe: view.ctx.recipe,
				baseVersionId: draft.base_version_id,
				policyVersion: 1,
			};
			return {
				status: "ready",
				input: {
					draftId: draft.id,
					requestId,
					messages: [
						{ role: "system", content: reviewInstructions },
						{ role: "user", content: JSON.stringify(payload) },
					],
				},
			};
		},
		async execute(input, context) {
			const receipt = await deps.inference.executeControl(
				input.requestId,
				input.messages,
				context.signal,
			);
			return { receipt };
		},
		settleInTransaction(db, claim, input, outcome) {
			const draft = repo.getDraft(db, claim.payload.draftId);
			if (outcome.type !== "success") {
				if (input)
					deps.inference.cancelRequestsInTransaction(db, [input.requestId]);
				if (draft)
					endDraft(
						db,
						clock,
						draft,
						"interrupted",
						outcome.type === "expired"
							? "draft_deadline"
							: outcome.type === "failed" ||
								  outcome.type === "retry" ||
								  outcome.type === "interrupted"
								? outcome.errorCode
								: "interrupted",
					);
				return "applied";
			}
			const { receipt } = outcome.result;
			if (!draft || draft.state !== "reviewing") {
				deps.inference.rejectControlInTransaction(
					db,
					receipt,
					"draft_not_reviewing",
				);
				return "applied";
			}
			const view = rendered(db, draft);
			const stop = stopReason(db, deps, draft, view?.ctx ?? null);
			if (stop || !view) {
				deps.inference.rejectControlInTransaction(
					db,
					receipt,
					stop?.code ?? "digest_mismatch",
				);
				endDraft(
					db,
					clock,
					draft,
					stop?.to ?? "rejected",
					stop?.code ?? "digest_mismatch",
				);
				return "applied";
			}
			const parsed = reviewOutput.safeParse(parseJson(receiptText(receipt)));
			const valid = parsed.success && parsed.data.draftDigest === view.r.digest;
			if (!valid) {
				deps.inference.rejectControlInTransaction(
					db,
					receipt,
					"review_contract",
				);
				return reject(db, draft, "review_contract", ["review_contract"]);
			}
			if (!deps.inference.acceptInTransaction(db, receipt)) {
				endDraft(db, clock, draft, "interrupted", "permission_revoked");
				return "applied";
			}
			if (parsed.data.decision === "rejected")
				return reject(
					db,
					draft,
					parsed.data.code ?? "review_rejected",
					parsed.data.problems,
				);
			// approved: register + CAS + activated in this same transaction (the registration owns the SAVEPOINT)
			registration.activateInTransaction(db, {
				draftId: draft.id,
				fence: {
					key: draft.key,
					epoch: draft.epoch,
					incarnation: draft.incarnation,
					generation: draft.base_generation,
				},
				baseVersionId: draft.base_version_id,
				reviewDigest: parsed.data.draftDigest,
			});
			return "applied";
		},
		cancelInTransaction(db: Database, job, reason) {
			const draft = repo.getDraft(db, job.payload.draftId);
			if (draft)
				endDraft(db, clock, draft, "interrupted", reason || "cancelled");
		},
	};
	function reject(
		db: Database,
		draft: repo.DraftRow,
		code: string,
		problems: string[],
	): "applied" {
		if (draft.corrections < 1) {
			repo.updateDraftContent(
				db,
				draft.id,
				{ corrections: 1, review_json: JSON.stringify({ code, problems }) },
				clock.now(),
			);
			repo.setDraftState(
				db,
				draft.id,
				["reviewing"],
				"queued",
				null,
				clock.now(),
			);
			try {
				enqueueStep(db, deps, draft, "author-2");
			} catch (e) {
				endDraft(
					db,
					clock,
					draft,
					"rejected",
					safe(e) === "queue_full" ? "queue_full" : "enqueue_failed",
				);
			}
		} else endDraft(db, clock, draft, "rejected", code);
		return "applied";
	}
}
