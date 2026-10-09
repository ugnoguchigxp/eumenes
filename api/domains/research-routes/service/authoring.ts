import type { Database } from "bun:sqlite";
import type { HandlerDefinition } from "../../queue";
import {
	type JobPayload,
	authorOutput,
	jobKinds,
	jobPayload,
	limits,
} from "../contracts";
import * as repo from "../repository";
import { authorInstructions, checkAuthor, renderDraft } from "./assets";
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
import type { Receipt, Messages } from "../../inference/contracts";

type Input = { draftId: string; requestId: string; messages: Messages };
type Output = { receipt: Receipt };

export const receiptText = (r: Receipt) =>
	typeof r.value === "string" ? r.value : new TextDecoder().decode(r.value);
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text.trim());
	} catch {
		return undefined;
	}
}

/** Draft deadline / step-ordinal checks shared by author and review prepare. */
export function authorStepFor(draft: repo.DraftRow) {
	return draft.corrections === 0 ? "author-1" : "author-2";
}

export function createAuthorHandler(
	deps: FlowDeps,
): HandlerDefinition<JobPayload, Input, Output> {
	const { clock } = deps;
	/** Author contract failure / review rejection both use the single correction here. */
	return {
		kind: jobKinds.author,
		payloadVersions: [1],
		schema: jobPayload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const draft = repo.getDraft(db, claim.payload.draftId);
			if (
				!draft ||
				draft.state !== "queued" ||
				authorStepFor(draft) !== claim.payload.step
			)
				return { status: "stale", reason: "draft_not_queued" };
			const ctx = draftContext(db, draft);
			const stop = stopReason(db, deps, draft, ctx);
			if (stop) {
				endDraft(db, clock, draft, stop.to, stop.code);
				return { status: "stale", reason: stop.code };
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
			repo.setDraftState(
				db,
				draft.id,
				["queued"],
				"authoring",
				null,
				clock.now(),
			);
			const previous = draft.review_json ? parseJson(draft.review_json) : null;
			const payload = {
				task: "author",
				spec: ctx!.spec,
				recipe: ctx!.recipe,
				facts: ctx!.proofFacts,
				instruction: draft.instruction,
				previousProblems: previous,
			};
			return {
				status: "ready",
				input: {
					draftId: draft.id,
					requestId,
					messages: [
						{ role: "system", content: authorInstructions },
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
			if (!draft || draft.state !== "authoring") {
				deps.inference.rejectControlInTransaction(
					db,
					receipt,
					"draft_not_authoring",
				);
				return "applied";
			}
			const ctx = draftContext(db, draft);
			const stop = stopReason(db, deps, draft, ctx);
			if (stop) {
				deps.inference.rejectControlInTransaction(db, receipt, stop.code);
				endDraft(db, clock, draft, stop.to, stop.code);
				return "applied";
			}
			const checked = checkAuthor(
				parseJson(receiptText(receipt)),
				ctx!.recipe,
				(v) => {
					const p = authorOutput.safeParse(v);
					return p.success ? p.data : null;
				},
			);
			if (!checked.ok) {
				deps.inference.rejectControlInTransaction(db, receipt, checked.code);
				if (draft.corrections < 1) {
					repo.updateDraftContent(
						db,
						draft.id,
						{
							corrections: 1,
							review_json: JSON.stringify({
								code: checked.code,
								problems: [checked.code],
							}),
						},
						clock.now(),
					);
					repo.setDraftState(
						db,
						draft.id,
						["authoring"],
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
				} else endDraft(db, clock, draft, "rejected", checked.code);
				return "applied";
			}
			if (!deps.inference.acceptInTransaction(db, receipt)) {
				endDraft(db, clock, draft, "interrupted", "permission_revoked");
				return "applied";
			}
			const rendered = renderDraft(
				checked.author,
				ctx!.spec,
				ctx!.recipe,
				draft.base_version_id,
			);
			repo.updateDraftContent(
				db,
				draft.id,
				{
					skill_draft: JSON.stringify({
						author: checked.author,
						digest: rendered.digest,
					}),
				},
				clock.now(),
			);
			repo.setDraftState(
				db,
				draft.id,
				["authoring"],
				"reviewing",
				null,
				clock.now(),
			);
			try {
				enqueueStep(
					db,
					deps,
					draft,
					draft.corrections === 0 ? "review-1" : "review-2",
				);
			} catch (e) {
				endDraft(
					db,
					clock,
					draft,
					"rejected",
					safe(e) === "queue_full" ? "queue_full" : "enqueue_failed",
				);
			}
			return "applied";
		},
		cancelInTransaction(db: Database, job, reason) {
			const draft = repo.getDraft(db, job.payload.draftId);
			if (draft)
				endDraft(db, clock, draft, "interrupted", reason || "cancelled");
		},
	};
}
