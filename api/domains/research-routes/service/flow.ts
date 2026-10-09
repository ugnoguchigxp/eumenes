import type { Database } from "bun:sqlite";
import type { EnqueueInput } from "../../queue";
import type { Capabilities } from "../../capabilities";
import type { Messages, Receipt } from "../../inference/contracts";
import {
	type AuthorStep,
	type JobPayload,
	type RouteRecipe,
	type SearchSpec,
	jobKinds,
	limits,
	ownerScope,
	routeRecipe,
	searchSpec,
} from "../contracts";
import * as repo from "../repository";
import type { Clock } from "./registry";

/** Structural slice of the inference service used for maintenance control calls. */
export type MaintenanceInference = {
	captureMaintenanceControlInTransaction(
		db: Database,
		input: { subject: string; deadline: number; maxOutputTokens: number },
	): string;
	executeControl(
		requestId: string,
		messages: Messages,
		signal: AbortSignal,
	): Promise<Receipt>;
	acceptInTransaction(db: Database, receipt: Receipt): boolean;
	rejectControlInTransaction(
		db: Database,
		receipt: Receipt,
		code: string,
	): void;
	cancelRequestsInTransaction(db: Database, requestIds: string[]): void;
};
export type QueueSlice = {
	enqueueInTransaction(db: Database, input: EnqueueInput): unknown;
};
export type SourceAdoptionDecision =
	| { status: "allowed" }
	| { status: "rejected"; code: string };
/**
 * Implemented by the application from agent-runtime / dialogue public operations. The original run
 * must still be completed + consumed with an unchanged report digest and data epoch.
 */
export type SourceAdoptionPort = {
	validateInTransaction(
		db: Database,
		input: {
			runId: string;
			taskId: string;
			ticketId: string;
			reportEpoch: number;
		},
	): SourceAdoptionDecision;
	/** Version ids currently held by running roots; they must survive GC. */
	protectedBindingsInTransaction?(db: Database): string[];
};
export type LearningCapabilities = Pick<
	Capabilities,
	"registerLearnedInTransaction" | "learnedUsageInTransaction"
>;
export type FlowDeps = {
	clock: Clock;
	queue: QueueSlice;
	capabilities: LearningCapabilities;
	inference: MaintenanceInference;
	adoption: SourceAdoptionPort;
	externalBytes: (db: Database) => number;
};

export const subjectOf = (draftId: string, step: AuthorStep) =>
	`research-route:${draftId}:${step}`;
export const kindOfStep = (step: AuthorStep) =>
	step.startsWith("author") ? jobKinds.author : jobKinds.review;

/** Enqueue one step. Throws (e.g. queue_full) so callers decide the draft's fate. */
export function enqueueStep(
	db: Database,
	deps: Pick<FlowDeps, "queue">,
	draft: Pick<repo.DraftRow, "id" | "expires_at">,
	step: AuthorStep,
) {
	const payload: JobPayload = { draftId: draft.id, step };
	deps.queue.enqueueInTransaction(db, {
		scope: ownerScope,
		kind: kindOfStep(step),
		payloadVersion: 1,
		dedupeKey: `${draft.id}:${step}`,
		payload,
		subjectRef: `${draft.id}:${step}`,
		lane: "background",
		resourceKey: "inference.llm",
		concurrencyKey: draft.id,
		deadlineAtMs: draft.expires_at,
		maxAttempts: 1,
	});
}

export type DraftContext = {
	spec: SearchSpec;
	recipe: RouteRecipe;
	proof: repo.ProofRow | null;
	proofFacts: unknown;
};
/** Draft inputs read back from the ledger; null if anything is missing or invalid. */
export function draftContext(
	db: Database,
	draft: repo.DraftRow,
): DraftContext | null {
	const key = repo.getKey(db, draft.epoch, draft.key);
	if (!key || key.incarnation !== draft.incarnation) return null;
	const spec = searchSpec.safeParse(JSON.parse(key.search_spec_json));
	if (!spec.success) return null;
	if (draft.origin === "adoption") {
		const proof = draft.proof_id ? repo.getProof(db, draft.proof_id) : null;
		if (!proof) return null;
		const stored = JSON.parse(proof.facts_json) as {
			facts: unknown;
			recipe: unknown;
		};
		const recipe = routeRecipe.safeParse(stored.recipe);
		if (!recipe.success) return null;
		return {
			spec: spec.data,
			recipe: recipe.data,
			proof,
			proofFacts: stored.facts,
		};
	}
	const base = draft.base_version_id
		? repo.getRevision(db, draft.base_version_id)
		: null;
	if (!base) return null;
	const recipe = routeRecipe.safeParse(JSON.parse(base.recipe_json));
	if (!recipe.success) return null;
	return {
		spec: spec.data,
		recipe: recipe.data,
		proof: null,
		proofFacts: null,
	};
}

export const stepDeadline = (clock: Clock, draft: repo.DraftRow) =>
	Math.min(clock.now() + limits.stepDeadlineMs, draft.expires_at);

/** Terminate a draft; a no-op if it already ended. Returns whether this call ended it. */
export function endDraft(
	db: Database,
	clock: Clock,
	draft: repo.DraftRow,
	to: "rejected" | "interrupted" | "superseded",
	code: string,
) {
	return repo.setDraftState(
		db,
		draft.id,
		["queued", "authoring", "reviewing"],
		to,
		code,
		clock.now(),
	);
}
export const safe = (e: unknown) =>
	e instanceof Error && /^[a-z0-9_]{1,64}$/.test(e.message)
		? e.message
		: "internal_error";

import { versionHealth, liveKey } from "./registry";
import { sha256 } from "../contracts";
/**
 * Is the draft still allowed to run? Returns the terminal state to apply, or null when it may proceed.
 * Adoption drafts re-check the original run through SourceAdoptionPort; edits re-check the base version.
 */
export function stopReason(
	db: Database,
	deps: FlowDeps,
	draft: repo.DraftRow,
	ctx: DraftContext | null,
): { to: "rejected" | "interrupted" | "superseded"; code: string } | null {
	const now = deps.clock.now();
	if (now >= draft.expires_at)
		return { to: "interrupted", code: "draft_deadline" };
	if (!ctx) return { to: "rejected", code: "draft_context_missing" };
	const k = liveKey(db, {
		key: draft.key,
		epoch: draft.epoch,
		incarnation: draft.incarnation,
		generation: draft.base_generation,
	});
	if (!k) return { to: "interrupted", code: "stale_fence" };
	if (!k.enabled) return { to: "interrupted", code: "route_disabled" };
	if (k.active_version_id !== draft.base_version_id)
		return { to: "superseded", code: "route_updated" };
	if (draft.origin === "adoption") {
		const p = ctx.proof;
		if (
			!p ||
			p.status !== "adopted" ||
			p.ticket_id === null ||
			p.report_epoch === null
		)
			return { to: "rejected", code: "proof_not_adopted" };
		const r = deps.adoption.validateInTransaction(db, {
			runId: p.root_run_id,
			taskId: p.task_id,
			ticketId: p.ticket_id,
			reportEpoch: p.report_epoch,
		});
		if (r.status !== "allowed") return { to: "interrupted", code: r.code };
	} else {
		const base = draft.base_version_id
			? repo.getRevision(db, draft.base_version_id)
			: null;
		if (
			!base ||
			versionHealth(db, k, now).health !== "healthy" ||
			sha256(base.registration_certificate_json) !==
				draft.base_certificate_digest
		)
			return { to: "superseded", code: "base_changed" };
	}
	return null;
}
