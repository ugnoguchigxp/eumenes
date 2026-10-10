import type { Database } from "bun:sqlite";
import type { Owner, FixedDefinition, Prepared } from "../../capabilities";
export type ToolResult = {
	observedAt: string;
	readings?: Source[];
	notes?: unknown;
	proofs?: Array<{ kind: "conversation_source"; scopeRef: string }>;
	hits: Array<{ url: string; title: string; snippet: string }>;
	documents: Array<{
		url: string;
		title: string;
		text: string;
		fetchedAt: string;
		truncated: boolean;
	}>;
	failures: Array<{ url: string; code: string }>;
};
export type Source = {
	kind?: "web_source" | "conversation_source";
	sourceRef?: string;
	sourceRevision?: string;
	viewId?: string;
	viewDigest?: string;
	start?: number;
	end?: number;
	nextCursor?: string | null;
	previousCursor?: string | null;
	acquisitionTruncated?: boolean;
	previewTruncated?: boolean;
	messageRef?: string;
	messageId?: string;
	conversationId?: string;
	speaker?: "user" | "assistant";
	createdAt?: string;
	revision?: string;
	digest?: string;
	scopeRef?: string;
	sourceId: string;
	url?: string;
	title: string;
	basis: "page" | "snippet" | "conversation";
	fetchedAt: string;
	truncated: boolean;
	body: string;
};
export type SourceMetadata = Omit<Source, "body">;
export type AdapterOperation = {
	state:
		| "pending"
		| "succeeded"
		| "partial"
		| "failed"
		| "cancelled"
		| "interrupted";
	result?: ToolResult;
	errorCode?: string;
};
export type ActionEnvelope = {
	kind: "local_action";
	backend: "timer";
	version: 1;
	operationId: string;
	receiptDigest: string;
	payload: unknown;
};
export interface ActionAdapter {
	/** Host snapshots for route selection; no model-generated identifiers. */
	contextInTransaction?(tx: Database, owner: Owner): unknown;
	executeInTransaction(
		tx: Database,
		request: {
			requestId: string;
			issuedAt: string;
			tool: FixedDefinition;
			arguments: unknown;
			owner: Owner;
			originToken: string;
		},
	): ActionEnvelope;
	readInTransaction(
		tx: Database,
		operationId: string,
		owner: Owner,
	): ActionEnvelope | null;
}
export interface ToolAdapter {
	operationFingerprintInTransaction?(
		tx: Database,
		request: { tool: FixedDefinition; arguments: unknown; owner: Owner },
	): string | undefined;
	localInTransaction?(
		tx: Database,
		request: {
			tool: FixedDefinition;
			arguments: unknown;
			owner: Owner;
			deadline: number;
		},
	): AdapterOperation;
	prepareSourcesInTransaction?(
		tx: Database,
		invocation: Invocation,
		result: ToolResult,
	): Source[] | undefined;
	validateEvidenceInTransaction?(
		tx: Database,
		owner: Owner,
		sources: SourceMetadata[],
		proofs: Array<{ kind: "conversation_source"; scopeRef: string }>,
	): boolean;
	releaseTask?(taskId: string): void;
	releaseRoot?(rootRunId: string): void;
	startInTransaction(
		tx: Database,
		request: {
			requestId: string;
			tool: FixedDefinition;
			arguments: unknown;
			owner: Owner;
			deadline: number;
			parentJobId: string;
			question?: string;
			/** Host-set per-attempt timeout for cached-route fetches (ms, from execute start). */
			attemptTimeoutMs?: number;
			/** Present for cached-route grants: the one URL the grant allows; adapters must verify the derived URL equals it. */
			grantedUrl?: string;
		},
	): { operationId: string; jobId: string };
	get(operationId: string): AdapterOperation | null;
	cancelInTransaction(tx: Database, operationId: string): string[];
}
/**
 * Owned by tool-runtime, implemented by the application on top of the route ledger.
 * Called when a cached grant/candidate import is issued and again on every use, so
 * clear/disable/rediscover/disqualification take effect without tool-runtime knowing keys.
 */
export type CachedSourceDecision =
	| { status: "allowed" }
	| { status: "rejected"; code: string };
export interface CachedSourceAuthorizationPort {
	validateInTransaction(
		tx: Database,
		input: {
			owner: Owner;
			bindingToken: string;
			packageHash: string;
			exactUrl: string;
		},
	): CachedSourceDecision;
}
export type CachedRouteGrantInput = {
	owner: Owner;
	prepared: Prepared;
	/** Opaque host-issued binding token; checked by the port, never minted by the model. */
	bindingToken: string;
	toolId: "web.read" | "web.forecast" | "web.quote";
	/** Fixed recipe arguments; the invocation must match them exactly. */
	arguments: unknown;
	exactUrl: string;
	deadline: number;
	attemptTimeoutMs?: number;
};
export type CandidateImportInput = {
	owner: Owner;
	/** Child's prepared fallback/cold package; its web.lookup tool carries the observation. */
	prepared: Prepared;
	bindingToken: string;
	stepId: string;
	deadline: number;
	/** Original normalized query of the cached search (provenance, not a new lookup). */
	query: string;
	searchedAt: string;
	/** Host digest of the stored candidate (kept for audit in args). */
	provenanceDigest: string;
	hits: Array<{ url: string; title: string; snippet: string }>;
};
export type Invocation = {
	args_json?: string | null;
	operation_fingerprint?: string | null;
	id: string;
	owner_task_id: string;
	root_run_id: string;
	tool_revision_id: string;
	step_id: string;
	args_digest: string;
	operation_id: string;
	job_id: string;
	state: string;
	result_ref: string | null;
	result_digest: string | null;
	error_code: string | null;
	deadline: number /** 'tool' for real executions, 'candidate-cache' for imported observations (needs routeGrantMigration). */;
	cancel_epoch?: number;
	origin?: "tool" | "candidate-cache";
};
