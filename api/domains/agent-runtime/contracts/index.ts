import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SourceMetadata } from "../../tool-runtime";
import { timerCommand, type Owner } from "../../capabilities/contracts";
export const reportSchema = z
	.object({
		summary: z.string().min(1).max(2000),
		claims: z
			.array(
				z
					.object({
						text: z.string().min(1).max(500),
						evidence: z
							.array(
								z
									.object({
										sourceId: z.string(),
										quote: z.string().min(1).max(400),
									})
									.strict(),
							)
							.min(1)
							.max(3),
					})
					.strict(),
			)
			.min(1)
			.max(8),
		limitations: z.array(z.string().max(300)).max(8),
	})
	.strict();
export type Report = z.infer<typeof reportSchema> & {
	sources: SourceMetadata[];
	coverage: "complete" | "partial";
	verification: "evidence_linked";
};
export const routeSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("respond") }).strict(),
	z
		.object({
			action: z.literal("clarify"),
			question: z.string().min(1).max(300),
		})
		.strict(),
	z
		.object({
			action: z.literal("discover"),
			intent: z.string().max(400),
			terms: z.array(z.string().min(1).max(80)).min(1).max(8),
		})
		.strict(),
	z
		.object({
			action: z.literal("timer"),
			command: timerCommand,
		})
		.strict(),
]);
export const selectSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("select"),
			candidateRef: z.string().uuid(),
			input: z.unknown(),
		})
		.strict(),
	z
		.object({
			action: z.literal("refine"),
			intent: z.string().max(400),
			terms: z.array(z.string().min(1).max(80)).min(1).max(8),
		})
		.strict(),
	z
		.object({
			action: z.literal("clarify"),
			question: z.string().min(1).max(300),
		})
		.strict(),
	z.object({ action: z.literal("unavailable") }).strict(),
]);
export const workerSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("invoke"),
			// The model uses the current tool's short name. Legacy opaque grants
			// remain accepted, but only the runtime can resolve either form.
			executionRef: z.string().min(1).max(128),
			arguments: z.unknown(),
		})
		.strict(),
	z
		.object({
			action: z.literal("finish"),
			report: reportSchema,
			// Opaque to the runtime: only an acquisition port may interpret it.
			facts: z.unknown().optional(),
		})
		.strict(),
]);
export type Task = {
	id: string;
	kind: "coordinator" | "worker";
	root_run_id: string;
	parent_task_id: string | null;
	package_revision_id: string | null;
	input_json: string | null;
	state: string;
	phase: string;
	revision: number;
	cancel_epoch: number;
	data_epoch: number;
	report_state: string;
	report_task_id: string | null;
	current_step: number;
	deadline: number;
	model_calls: number;
	tool_calls: number;
	json_repairs: number;
	refinements: number;
	job_id: string | null;
	invocation_id: string | null;
	error_code: string | null;
	created_at: number;
	updated_at: number;
	// Added by acquisitionMigration; absent/null on pre-port rows.
	acquisition_plan_json?: string | null;
	acquisition_binding_json?: string | null;
};
export type TaskDto = {
	id: string;
	kind: Task["kind"];
	rootRunId: string;
	parentTaskId: string | null;
	packageRevisionId: string | null;
	status: string;
	phase: string;
	modelCalls: number;
	toolCalls: number;
	errorCode: string | null;
	createdAt: string;
	deadlineAt: string;
	reportState: string;
	/** Generic progress mode derived from the acquisition plan: no site-specific data. */
	acquisitionMode?: AcquisitionMode | null;
};
export type AcquisitionMode = "search" | "candidate" | "cached" | "rediscover";
export const taskDtoSchema = z.object({
	id: z.string(),
	kind: z.enum(["coordinator", "worker"]),
	rootRunId: z.string(),
	parentTaskId: z.string().nullable(),
	packageRevisionId: z.string().nullable(),
	status: z.string(),
	phase: z.string(),
	modelCalls: z.number(),
	toolCalls: z.number(),
	errorCode: z.string().nullable(),
	createdAt: z.string(),
	deadlineAt: z.string(),
	reportState: z.string(),
	acquisitionMode: z
		.enum(["search", "candidate", "cached", "rediscover"])
		.nullable()
		.optional(),
	toolOutcomes: z
		.array(
			z.object({
				toolRevisionId: z.string(),
				state: z.string(),
				errorCode: z.string().nullable(),
				sourceCount: z.number(),
			}),
		)
		.optional(),
});
export type AnswerTicket = {
	taskId: string;
	eventId: string;
	revision: number;
	dataEpoch: number;
	reportTaskId: string | null;
	reportEpoch: number | null;
	reportDigest: string | null;
	projection: string | null;
	failureCode: string | null;
	/** Digest of the host-verified safe projection, when the report came through an acquisition port. */
	projectionDigest?: string | null;
	/** Binding token of the child that produced the report (cached-authority recheck at adoption). */
	acquisitionBindingToken?: string | null;
	/** Saved timer receipt, when this answer is an action rather than research. */
	actionPayload?: string | null;
	actionFailure?: boolean;
};

// ---------- generic acquisition plan port (owned here; implemented by application) ----------
export type AcquisitionSource = {
	sourceId: string;
	url: string;
	body: string;
	basis: string;
	fetchedAt: string;
	truncated: boolean;
};
export type AcquisitionLookupProvenance = {
	origin: "lookup" | "candidate-cache";
	runId: string;
	stepId: string;
	query: string;
	searchedAt: number;
	provider: string;
	digest: string;
} | null;
export type AcquisitionInitialAction =
	| { kind: "host-lookup"; query: string; language: string; region: string }
	| {
			kind: "candidate-import";
			/** Original normalized query / time of the cached search (provenance, not a new lookup). */
			query: string;
			searchedAt: number;
			provenanceDigest: string;
			hits: Array<{ url: string; title: string; snippet: string }>;
			/** Provenance of the ORIGINAL lookup that produced these hits. */
			provenance: NonNullable<AcquisitionLookupProvenance>;
	  }
	| {
			kind: "direct-invoke";
			toolId: "web.read" | "web.forecast" | "web.quote";
			/** Fixed recipe arguments; the invocation must match exactly. */
			arguments: unknown;
			exactUrl: string;
			attemptTimeoutMs?: number;
	  };
export type AcquisitionResolveInput = {
	rootRunId: string;
	coordinatorTaskId: string;
	question: string;
	requestAtMs: number;
	/** Set only when replacing a failed plan: the answer must be a normal search even if the route stays healthy. */
	replaceReason?: string;
};
export type AcquisitionProposal =
	| { kind: "unmatched" }
	| { kind: "clarification"; question: string }
	| {
			kind: "search-first";
			proposalToken: string;
			query: string;
			language: string;
			region: string;
	  }
	| { kind: "candidate"; proposalToken: string }
	| { kind: "direct"; proposalToken: string; packageRevisionId: string }
	| { kind: "unavailable"; code: string };
export type AcquisitionBindResult =
	| {
			kind: "bound";
			bindingToken: string;
			packageRevisionId: string;
			initialAction: AcquisitionInitialAction;
	  }
	| { kind: "rejected"; code: string };
export type AcquisitionObservationInput = {
	bindingToken: string;
	owner: Owner;
	visibleSources: AcquisitionSource[];
	lookupProvenance: AcquisitionLookupProvenance;
	tools: {
		toolId: string;
		stepId: string;
		argsDigest: string;
		state: string;
		origin?: string;
		superseded?: boolean;
	}[];
	report: Report;
	facts: unknown;
};
export type AcquisitionObservationResult =
	| {
			kind: "valid";
			proofId: string | null;
			canonicalReportPatch: {
				summary: string;
				claims: {
					text: string;
					evidence: { sourceId: string; quote: string }[];
				}[];
				limitations: string[];
			};
			safeProjection: {
				summary: string;
				claims: { text: string; sourceIds: string[] }[];
				limitations: string[];
			};
			projectionDigest: string;
	  }
	| { kind: "source_unusable"; code: string }
	| { kind: "report_invalid"; code: string }
	| { kind: "policy_unavailable"; code: string };
export interface AcquisitionPlanPort {
	resolveInTransaction(
		db: Database,
		input: AcquisitionResolveInput,
	): AcquisitionProposal;
	bindInTransaction(
		db: Database,
		input: { proposalToken: string; childOwner: Owner; deadline: number },
	): AcquisitionBindResult;
	validateInTransaction(
		db: Database,
		input: { bindingToken: string; owner: Owner; stage: "prepare" | "finish" },
	): { kind: "allowed" } | { kind: "rejected"; code: string };
	recordObservationInTransaction(
		db: Database,
		input: AcquisitionObservationInput,
	): AcquisitionObservationResult;
	validateAdoptionInTransaction(
		db: Database,
		input: { bindingToken: string; owner: Owner; projectionDigest: string },
	): { kind: "allowed" } | { kind: "rejected"; code: string };
	releaseInTransaction(
		db: Database,
		input: { bindingToken: string; owner: Owner; reason?: string },
	): { kind: "released" } | { kind: "stale" };
}
/** Persisted on the child task (agent_tasks.acquisition_binding_json). */
export type StoredBinding = {
	bindingToken: string;
	packageRevisionId: string;
	initialAction: AcquisitionInitialAction;
	lookupProvenance: AcquisitionLookupProvenance;
	/** Number of times this child's plan was replaced by a normal search plan (max 1). */
	replacements?: number;
};
/** Host-only evidence that an answer was adopted; no conversation text. */
export type AdoptedEvidence = {
	rootRunId: string;
	rootTaskId: string;
	childTaskId: string;
	ticketId: string;
	rootDataEpoch: number;
	reportEpoch: number;
	reportDigest: string;
	projectionDigest: string | null;
	bindingToken: string | null;
};
