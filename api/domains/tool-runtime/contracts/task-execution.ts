import type { Database } from "bun:sqlite";
import type { ToolchainCard } from "../../capabilities";
import { z } from "zod";

/** Source identities are issued by the host, never reconstructed from model prose. */
export const executionReference = z.strictObject({
	ref: z.string().min(1).max(160),
	owner: z.string().min(1).max(80),
	id: z.string().min(1).max(160),
	revision: z.string().max(160),
	digest: z.string().min(1).max(160),
	label: z.string().max(200),
	kind: z.enum([
		"message",
		"memory",
		"world",
		"result",
		"artifact",
		"resource",
	]),
	preview: z.string().max(2000),
});
export type ExecutionReference = z.infer<typeof executionReference>;
export const executionControl = z.strictObject({
	workRef: z.uuid(),
	expectedRevision: z.number().int().min(0),
	action: z.enum(["status", "answer", "amend", "cancel"]),
	questionRef: z.uuid().optional(),
	input: z.unknown().optional(),
	request: z.string().trim().min(1).max(8000).optional(),
});
export type ExecutionStatus =
	| "queued"
	| "deciding"
	| "waiting_child"
	| "waiting_user"
	| "completed"
	| "partial"
	| "failed"
	| "cancelled"
	| "interrupted";
export type ExecutionResult = {
	status: ExecutionStatus;
	summary: string;
	fulfilled: string[];
	missing: string[];
	refs: string[];
	code?: string;
	/** Resource URIs the execution's children made (resource-uri plan §6.3). */
	links?: string[];
	/** A research owner's bounded report; source IDs are issued only after reading a guarded body. */
	answer?: string;
	sources?: Array<{
		sourceId: string;
		url: string;
		title: string;
		fetchedAt: string;
	}>;
	claims?: Array<{
		text: string;
		status: "verified" | "unknown" | "conflicting";
		sourceIds: string[];
	}>;
	limitations?: string[];
	assurance?: "model";
	stopReason?: string;
};
export type ExecutionView = {
	id: string;
	conversationId: string;
	request: string;
	revision: number;
	status: ExecutionStatus;
	deadline: number;
	question: {
		id: string;
		prompt: string;
		expiresAt: number;
		inputSchema: Record<string, unknown>;
	} | null;
	result: ExecutionResult | null;
	/** A task pipeline's run: its fixed steps answer for the request as one step of it. */
	pipeline?: true;
};
export type ExecutionSource = {
	conversationId: string;
	messageId: string;
	runId: string;
	request: string;
	digest: string;
	/** Host-issued authority of a collaborative session. Never inferred from model output. */
	specialistSessionId?: string;
	specialistEpoch?: number;
	amendments?: Array<{ messageId: string; request: string; digest: string }>;
	responses?: Array<{ messageId: string; request: string; digest: string }>;
};
/** A registered task owner. Dialogue owns the TODO; this port owns the actual work. */
export interface TaskLifecyclePort {
	startInTransaction(
		db: Database,
		input: {
			source: ExecutionSource;
			request: string;
			references: ExecutionReference[];
			toolchainRevisionId?: string;
			bindingRevisionId?: string;
		},
	): ExecutionView;
	controlInTransaction(
		db: Database,
		conversationId: string,
		input: unknown,
		messageId: string,
	): ExecutionView;
	viewInTransaction(db: Database, id: string): ExecutionView | null;
	cancelInTransaction?(db: Database, conversationId: string, id: string): void;
	forgetInTransaction?(db: Database, id: string): void;
}
export type ChildExecution = {
	id: string;
	dispatchId?: string;
	usedModelCalls?: number;
	executionId: string;
	revision: number;
	step: number;
	chainRevisionId: string;
	request: string;
	arguments?: Record<string, unknown>;
	refs: ExecutionReference[];
	referenceData?: Array<{ ref: string; text: string }>;
	source: ExecutionSource;
	deadline: number;
	modelCalls: number;
	resume?: {
		questionId: string;
		input: unknown;
		previous: unknown;
		answerMessageId: string;
	};
};
export type ChildResult = {
	state:
		| "running"
		| "waiting_input"
		| "completed"
		| "partial"
		| "failed"
		| "cancelled"
		| "expired"
		| "indeterminate"
		| "handoff";
	ref: unknown;
	summary: string;
	question?: string;
	questionSchema?: Record<string, unknown>;
	questionDeadline?: number;
	output?: unknown;
	code?: string;
	modelCalls: number;
	references: ExecutionReference[];
	/**
	 * Resource URIs the sub-agent reported as made by this execution (`finish.links`), already checked against the
	 * URIs its tools returned and the ones handed to it (resource-uri plan §6.3).
	 */
	links?: string[];
};
/** Composition only: the host connects domain-owned public operations. */
export interface ToolchainExecutionPort {
	/** Shared domain-task lifecycle, also callable by research invocation owners. */
	childOperations?: import("./child-operation").ChildOperationPort;
	validSourceInTransaction(db: Database, source: ExecutionSource): boolean;
	controlSourceInTransaction(
		db: Database,
		conversationId: string,
		messageId: string,
		forSource?: ExecutionSource,
	): { messageId: string; request: string; digest: string } | null;
	validReferenceInTransaction(
		db: Database,
		source: ExecutionSource,
		ref: ExecutionReference,
	): boolean;
	readReferenceInTransaction(
		db: Database,
		source: ExecutionSource,
		ref: ExecutionReference,
		start: number,
		limit: number,
	): string;
	cardInTransaction(
		db: Database,
		revisionId: string,
	): ToolchainCard | undefined;
	find(
		query: string,
		source: ExecutionSource,
		signal: AbortSignal,
	): Promise<ToolchainCard[]>;
	childDeadlineInTransaction?(
		db: Database,
		revisionId: string,
		deadline: number,
	): number;
	prepareInTransaction(db: Database, child: ChildExecution): unknown;
	execute(
		prepared: unknown,
		child: ChildExecution,
		signal: AbortSignal,
	): Promise<ChildResult>;
	currentInTransaction(
		db: Database,
		child: ChildExecution,
		ref: unknown,
	): ChildResult;
	adoptInTransaction(
		db: Database,
		child: ChildExecution,
		result: ChildResult,
	): boolean;
	cancelInTransaction(db: Database, child: ChildExecution, ref: unknown): void;
	validateAnswerInTransaction(
		db: Database,
		child: ChildExecution,
		result: ChildResult,
		input: unknown,
	): boolean;
	purgeSourcesInTransaction?(
		db: Database,
		source: ExecutionSource,
		children: ChildExecution[],
	): void;
	revokeDeliveryInTransaction?(db: Database, eventId: string): void;
	flush(): void;
	/** A sent notice is acknowledged only after the conversation's run for it completes. */
	deliveryStateInTransaction?(
		db: Database,
		eventId: string,
	): "pending" | "delivered" | "failed";
	deliverInTransaction(
		db: Database,
		view: ExecutionView,
		eventId: string,
	): boolean;
	/** Published pipeline planner, resolved through the same registry as other toolchains. */
	pipelineInTransaction?(
		db: Database,
		toolchainRevisionId: string,
	): { bindingRevisionId: string; instructions: string; runMs: number } | null;
	pipelineCatalogInTransaction?(
		db: Database,
		source: ExecutionSource,
	): import("eumenes-pipeline").ComponentRecord[];
	/** The revision of the toolchain a pipeline step names that a child may run now; null when none may. */
	stepToolchainInTransaction?(
		db: Database,
		toolchainId: string,
		source: ExecutionSource,
	): string | null;
	/** Frozen parent instructions from the published package, without a model/provider name. */
	controlInTransaction(db: Database): {
		revisionId: string;
		instructions: string;
		runMs: number;
		limits: {
			parentCalls: number;
			childCalls: number;
			searches: number;
			modelCalls: number;
		};
	} | null;
}
export type ParentDecision = {
	name: string;
	arguments: Record<string, unknown>;
};

/** Every copied source is attached to the inference revocation contract. */
export function executionCallSession(child: ChildExecution) {
	return {
		sessionRole: "subagent" as const,
		taskId: child.id,
		agentSession: {
			conversationId: child.source.conversationId,
			agentId: child.id,
		},
		refs: {
			conversationId: child.source.conversationId,
			messageIds: [
				child.source.messageId,
				...(child.source.amendments ?? []).map((update) => update.messageId),
				...(child.source.responses ?? []).map((update) => update.messageId),
				...(child.resume ? [child.resume.answerMessageId] : []),
				...child.refs.filter((r) => r.kind === "message").map((r) => r.id),
			],
			itemIds: child.refs.filter((r) => r.kind === "memory").map((r) => r.id),
		},
	};
}

/** Bounded conversation projection; the persisted result remains the source of truth. */
export function executionNoticeResult(result: ExecutionResult | null) {
	return result
		? {
				...result,
				summary: result.summary.slice(0, 2000),
				fulfilled: result.fulfilled.slice(0, 8).map((x) => x.slice(0, 120)),
				missing: result.missing.slice(0, 8).map((x) => x.slice(0, 120)),
				refs: result.refs.slice(0, 8),
			}
		: null;
}
