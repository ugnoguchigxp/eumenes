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
	| "stopping"
	| "completed"
	| "partial"
	| "failed"
	| "cancelled"
	| "interrupted";
export type ExecutionDocument = {
	id: string;
	title: string;
	path: string;
	local: { state: "saved" | "failed" | "expired"; uri?: string; code?: string };
	archive: {
		state: "saved" | "unsaved" | "unknown" | "conflict";
		sourceId?: string;
		code?: string;
	};
};
export type ExecutionResult = {
	status: ExecutionStatus;
	summary: string;
	fulfilled: string[];
	missing: string[];
	refs: string[];
	code?: string;
	/** A research note's own title (a note owner that has no saved document). */
	title?: string;
	/** Resource URIs the execution's children made (resource-uri plan §6.3). */
	links?: string[];
	document?: ExecutionDocument;
	/** A research owner's bounded report; source IDs are issued only after reading a guarded body. */
	answer?: string;
	/** A task owner may deliver its bounded answer verbatim in the requesting conversation. */
	replyInConversation?: true;
	/** Complete visual rendering for a conversation reply. Never part of a work or agent projection. */
	displayAnswer?: string;
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
	report?: ExecutionEvidenceReport;
};
export type ExecutionEvidenceReport = {
	summary: string;
	outcome?: string;
	coverage: "complete" | "partial";
	verification: "evidence_linked";
	claims: Array<{ text: string; sourceIds: string[] }>;
	limitations: string[];
	sources: Array<{
		sourceId: string;
		kind?: string;
		title?: string;
		url?: string;
		revision?: string;
		start?: number;
		end?: number;
		documentId?: string;
		fetchedAt?: string;
		location?: {
			path: string;
			symbol: string | null;
			commit: string;
			startLine: number;
			endLine: number;
			digest: string;
		};
	}>;
};
/** A named, independently controlled task of a registered execution owner. */
export type ExecutionTaskView = {
	taskId: string;
	revision: number;
	title: string;
	state: "waiting" | "running" | "held" | "finished";
	reason: string;
	result: ExecutionResult | null;
	evidenceRefs: readonly string[];
	outcome?: "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
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
	progress?: {
		summary: string;
		observedAt: number;
	};
	/** Subtasks with scoped controls, supplied by the same owner as the parent view. */
	tasks?: readonly ExecutionTaskView[];
	conversationSummary?: "on_read" | "next_turn";
	stop?: "requested" | "confirmed" | "unconfirmed";
	/** A task pipeline's run: its fixed steps answer for the request as one step of it. */
	pipeline?: true;
};
/** One ordered request handed from the router to the pipeline planner. */
export type RoutedPipelineStep = {
	text: string;
	entry: string;
	revisionId: string;
	after: readonly number[];
};

export type ExecutionResponse = {
	messageId: string;
	request: string;
	digest: string;
	/** A verified response sent to a specialist following a pre-existing execution. */
	specialistSessionId?: string;
};
type StandardExecutionSource = {
	conversationId: string;
	messageId: string | null;
	/** A persisted Agency work owns autonomous execution; never a user-message identity. */
	origin?: "autonomous" | "workflow";
	delegation?: never;
	/** Host-issued reference to an accepted, scoped workflow run. */
	workflow?: { scope: string; definitionId: string; revision: number };
	agency?: {
		epoch: number;
		ticketId: string;
		capabilityRevisionId: string;
		policyDigest: string;
	};
	runId: string;
	request: string;
	digest: string;
	/** Host-issued authority of a collaborative session. Never inferred from model output. */
	specialistSessionId?: string;
	specialistEpoch?: number;
	amendments?: ExecutionResponse[];
	responses?: ExecutionResponse[];
};
/** Only the supervision owner can issue this receipt. Revalidate it at the registered child owner. */
type SupervisedExecutionBase = {
	origin: "supervised";
	messageId: null;
	runId: string;
	request: string;
	digest: string;
	delegation: {
		grantRef: string;
		parentWorkId: string;
		taskId: string;
		parentGeneration: number;
		taskGeneration: number;
	};
	workflow?: never;
	agency?: never;
	specialistSessionId?: never;
	specialistEpoch?: never;
	amendments?: never;
	responses?: never;
};
export type GoalExecutionIdentity = {
	principal: string;
	scopeKey: string;
	goalId: string;
	goalRevision: number;
	attemptId: string;
	permitId: string;
	permitRevision: number;
};
export type GoalExecutionSource = GoalExecutionIdentity & {
	origin: "goal";
	conversationId?: never;
	messageId?: never;
	delegation?: never;
	runId: string;
	request: string;
	expectedObservation: string;
	toolchainRevisionId: string;
	bindingRevisionId: string;
	digest: string;
};
export type SupervisedExecutionSource = SupervisedExecutionBase & {
	conversationId: string;
	goal?: never;
};
export type GoalSupervisedExecutionSource = SupervisedExecutionBase & {
	conversationId: null;
	goal: GoalExecutionIdentity;
};
export type OwnedSupervisedExecutionSource =
	SupervisedExecutionSource | GoalSupervisedExecutionSource;
export type OwnedExecutionView = Omit<ExecutionView, "conversationId"> &
	(
		| { conversationId: string; goal?: never }
		| { conversationId: null; goal: GoalExecutionIdentity }
	);
export type ExecutionSource =
	StandardExecutionSource | SupervisedExecutionSource;

const supervisedSourceShape = z.strictObject({
	origin: z.literal("supervised"),
	conversationId: z.string().min(1),
	messageId: z.null(),
	runId: z.string().min(1),
	request: z.string().min(1).max(8000),
	digest: z.string().min(1),
	delegation: z.strictObject({
		grantRef: z.string().min(1),
		parentWorkId: z.string().min(1),
		taskId: z.string().min(1),
		parentGeneration: z.number().int().nonnegative(),
		taskGeneration: z.number().int().nonnegative(),
	}),
});
const goalIdentity = z.strictObject({
	principal: z.string().min(1),
	scopeKey: z.string().min(1),
	goalId: z.string().min(1),
	goalRevision: z.number().int().positive(),
	attemptId: z.uuid(),
	permitId: z.uuid(),
	permitRevision: z.number().int().positive(),
});
const ownedSupervisedSource = supervisedSourceShape.extend({
	conversationId: z.null(),
	goal: goalIdentity,
});
const goalSource = goalIdentity.extend({
	origin: z.literal("goal"),
	runId: z.uuid(),
	request: z.string().min(1).max(8000),
	expectedObservation: z.string().min(1).max(8000),
	toolchainRevisionId: z.string().min(1),
	bindingRevisionId: z.string().min(1),
	digest: z.string().min(1),
});
export function isGoalExecutionSource(
	source: unknown,
): source is GoalExecutionSource {
	return goalSource.safeParse(source).success;
}

export function isSupervisedExecutionSource(
	source: unknown,
): source is OwnedSupervisedExecutionSource {
	return (
		supervisedSourceShape.safeParse(source).success ||
		ownedSupervisedSource.safeParse(source).success
	);
}

/** Persisted sources can come from older versions. Unknown origins have no ordinary execution authority. */
export function isStandardExecutionSource(
	source: ExecutionSource | GoalSupervisedExecutionSource | GoalExecutionSource,
): source is StandardExecutionSource {
	return (
		!!source &&
		typeof source === "object" &&
		source.delegation === undefined &&
		(source.origin === undefined ||
			source.origin === "autonomous" ||
			source.origin === "workflow")
	);
}
/** A registered task owner. Dialogue owns the TODO; this port owns the actual work. */
export interface TaskLifecyclePort {
	/** This registered owner runs its own selected package as a research worker. */
	selectedWorker?: true;
	startInTransaction(
		db: Database,
		input: {
			source: ExecutionSource;
			request: string;
			references: ExecutionReference[];
			confirmationId?: string;
			toolchainRevisionId?: string;
			bindingRevisionId?: string;
			deadline?: number;
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
	selectedWorker?: true;
	id: string;
	dispatchId?: string;
	usedModelCalls?: number;
	executionId: string;
	revision: number;
	step: number;
	pipelineStepId?: string;
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
	report?: ExecutionEvidenceReport;
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
	autonomyInTransaction?(
		db: Database,
		revisionId: string,
	): {
		automatic: boolean;
		reason: string;
		operations: string[];
		effect?: "read" | "create";
	};
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
		options?: { lexicalFallback?: boolean },
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
	workflowPlanInTransaction?(
		db: Database,
		source: ExecutionSource,
	): {
		definition: unknown;
		steps: readonly { stepId: string; toolchainRevisionId: string }[];
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
		agentSession: {
			conversationId: child.source.conversationId,
			agentId: child.id,
		},
		refs: {
			conversationId: child.source.conversationId,
			messageIds: [
				...(child.source.messageId ? [child.source.messageId] : []),
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
	if (!result) return null;
	const { displayAnswer: _displayAnswer, ...publicResult } = result;
	return {
		...publicResult,
		...(result.replyInConversation ? { answer: result.summary } : {}),
		summary: result.summary.slice(0, 2000),
		fulfilled: result.fulfilled.slice(0, 8).map((x) => x.slice(0, 120)),
		missing: result.missing.slice(0, 8).map((x) => x.slice(0, 120)),
		refs: result.refs.slice(0, 8),
	};
}
