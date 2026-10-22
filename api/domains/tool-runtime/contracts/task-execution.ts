import type { Database } from "bun:sqlite";
import type { PipelineDefinition, ToolchainCard } from "../../capabilities";
import { z } from "zod";

/** Source identities are issued by the host, never reconstructed from model prose. */
export const executionReference = z.strictObject({
	ref: z.string().min(1).max(160),
	owner: z.string().min(1).max(80),
	id: z.string().min(1).max(160),
	revision: z.string().max(160),
	digest: z.string().min(1).max(160),
	label: z.string().max(200),
	kind: z.enum(["message", "memory", "world", "result", "artifact"]),
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
export type ExecutionControl = z.infer<typeof executionControl>;
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
	amendments?: Array<{ messageId: string; request: string; digest: string }>;
	responses?: Array<{ messageId: string; request: string; digest: string }>;
};
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
	/** A sent notice is acknowledged only after the conversation adopts its answer. */
	deliveryStateInTransaction?(
		db: Database,
		eventId: string,
	): "pending" | "delivered" | "failed";
	deliverInTransaction(
		db: Database,
		view: ExecutionView,
		eventId: string,
	): boolean;
	/**
	 * A task pipeline revision and its binding (spec task-pipeline-design 2026-10-22 §13.4); null when its pipeline is
	 * no longer published or not runnable on this host now. A later revision of the same pipeline keeps it valid.
	 */
	pipelineInTransaction?(
		db: Database,
		toolchainRevisionId: string,
	): {
		bindingRevisionId: string;
		definition: PipelineDefinition;
		runMs: number;
	} | null;
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
