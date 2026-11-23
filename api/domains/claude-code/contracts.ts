import { z } from "zod";
import type {
	ExecutionResult,
	ExecutionSource,
	ToolchainExecutionPort,
	ExecutionStatus,
	ExecutionView,
	TaskLifecyclePort,
	SupervisedExecutionSource,
} from "../tool-runtime";
import type { Database } from "bun:sqlite";

export const adapterRef = "adapter:claude-code-task@1";
export const questionAnswer = z.string().trim().min(1).max(2_000);
const brief = {
	summary: z.string().trim().min(1).max(320),
	memo: z.string().max(4_000),
};
const item = z.string().max(400);
export const decisionSchema = z.discriminatedUnion("action", [
	z.strictObject({
		action: z.literal("invoke"),
		...brief,
		instruction: z.string().trim().min(1).max(8_000),
	}),
	z.strictObject({
		action: z.literal("ask_user"),
		...brief,
		question: questionAnswer,
	}),
	z.strictObject({
		action: z.literal("reply"),
		...brief,
		answer: questionAnswer,
	}),
	z.strictObject({
		action: z.literal("read_events"),
		...brief,
		after: z.number().int().nonnegative().max(1_000_000),
	}),
	z.strictObject({ action: z.literal("wait"), ...brief }),
	z.strictObject({
		action: z.literal("finish"),
		...brief,
		status: z.enum(["completed", "partial", "failed"]),
		fulfilled: z.array(item).max(10),
		missing: z.array(item).max(10),
		refs: z.array(z.string().max(160)).max(12),
	}),
]);
export type Decision = z.infer<typeof decisionSchema>;
export type Question = NonNullable<ExecutionView["question"]> & {
	presentation?: "waiting" | "presented";
	kind?: "question" | "permission";
	tool?: string;
	options?: string[];
	multiSelect?: boolean;
};
export type {
	ClaudeObservation as Observation,
	ClaudeStart as Start,
	ClaudeRunAuthorization,
	ClaudeEvidence,
	ClaudeLease,
	ClaudeEventsResponse,
} from "../coding";
import type {
	ClaudeObservation as Observation,
	ClaudeStart as Start,
	ClaudeRunAuthorization,
	ClaudeEvidence,
	ClaudeLease,
	ClaudeEventsResponse,
} from "../coding";
export interface Runner {
	ready(): boolean;
	probe?(): Promise<boolean>;
	start(operation: Start): Promise<Observation>;
	inspect(id: string): Promise<Observation | null>;
	events?(id: string, after: number): Promise<ClaudeEventsResponse>;
	reply(
		id: string,
		operationId: string,
		questionId: string,
		answer: string,
	): Promise<Observation>;
	stop(
		id: string,
		operationId: string,
		supervised?: Start["supervised"],
	): Promise<Observation | null>;
	supportsSupervised?(): boolean;
	present?(id: string, questionId: string, expiresAt: number): Promise<void>;
	recover?(
		id: string,
		lease: ClaudeLease,
		proof: "process_exit" | "host_reboot",
	): Promise<Observation>;
	approveTool?(
		id: string,
		requestId: string,
		lease: ClaudeLease,
	): Promise<void>;
}

export type SupervisedAuthority = {
	source: SupervisedExecutionSource;
	workId?: string;
	toolchainRevisionId: string;
	bindingRevisionId: string;
	request: string;
	action:
		| "start"
		| "continue"
		| "inspect"
		| "view"
		| "stop"
		| "cancel"
		| "present"
		| "answer";
	operationId?: string;
	questionId?: string;
	parentQuestionId?: string;
	messageId?: string;
};
export type SupervisedStart = Parameters<
	TaskLifecyclePort["startInTransaction"]
>[1] & {
	source: SupervisedExecutionSource;
	operationId: string;
	toolchainRevisionId: string;
	bindingRevisionId: string;
};
export type SupervisedPresentation = {
	operationId: string;
	questionId: string;
	parentQuestionId: string;
	presentedAt: number;
	expiresAt: number;
};
export type SupervisedAnswer = Pick<
	SupervisedPresentation,
	"operationId" | "questionId" | "parentQuestionId"
> & {
	messageId: string;
	answer: string;
};
export type SupervisedView = {
	view: ExecutionView;
	executionId: string | null;
	questionExecutionId?: string | null;
	evidence: ClaudeEvidence[];
	releaseConfirmed: boolean;
	blocking?: { state: "waiting" | "held"; reason: string };
	answerDelivery?: {
		operationId: string;
		state: "pending" | "delivered" | "failed";
	};
};

export type Work = {
	id: string;
	source: ExecutionSource;
	binding: string;
	request: string;
	references: Parameters<
		TaskLifecyclePort["startInTransaction"]
	>[1]["references"];
	profile: string;
	skills: string[];
	deadline: number;
	generation: number;
	revision: number;
	status: ExecutionStatus;
	summary: string;
	observedAt: number;
	memo: string;
	question: Question | null;
	questionFromRunner: boolean;
	pendingRunnerQuestion?: Question | null;
	result: ExecutionResult | null;
	observation: Observation | null;
	knownEvidenceRefs?: string[];
	eventCursor?: number;
	eventExcerpts?: { executionId: string; seq: number; text: string }[];
	decisionRetries?: number;
	calls: number;
	executions: number;
	turnsReserved: number;
	turnsUsedBeforeExecution: number;
	maxCalls: number;
	maxExecutions: number;
	attemptMs: number;
	decisionId: string | null;
	decisionMode: "work" | "progress" | "question";
	progressCalls: number;
	progressSeq: number;
	progressAt: number;
	effect:
		| { kind: "start"; operation: Start }
		| { kind: "reply"; id: string; questionId: string; answer: string }
		| { kind: "read_events"; executionId: string; after: number }
		| {
				kind: "stop";
				id: string;
				reason: "cancel" | "amend" | "expired" | "forgotten";
		  }
		| null;
	executionId: string | null;
	previousId: string | null;
	answers: { messageId: string; question: string; answer: string }[];
	amendments: { messageId: string; text: string }[];
	notice: string | null;
	deliveredNotice?: string;
	stopAt?: number;
	forgotten: boolean;
	holdsWorkspace: boolean;
	stop: ExecutionView["stop"];
	mode: "work" | "analysis";
	conversationSummary: ExecutionView["conversationSummary"];
	supervision?: {
		toolchainRevisionId: string;
		authorization: ClaudeRunAuthorization;
		lease?: ClaudeLease;
		presentation?: SupervisedPresentation & { sent?: boolean };
		answerDelivery?: SupervisedView["answerDelivery"];
		evidence?: ClaudeEvidence[];
		blocked?: Observation["blocked"];
	};
};

export type Host = Pick<
	ToolchainExecutionPort,
	"controlSourceInTransaction" | "validReferenceInTransaction"
> & {
	validSourceInTransaction(db: Database, source: ExecutionSource): boolean;
	deliverInTransaction(db: Database, view: ExecutionView, id: string): boolean;
	revokeInTransaction(db: Database, eventId: string): void;
	supervised?: {
		authorizeInTransaction(
			db: Database,
			input: SupervisedAuthority,
		): ClaudeRunAuthorization | null;
		observeInTransaction(
			db: Database,
			source: SupervisedExecutionSource,
			view: ExecutionView,
			eventId: string,
		): boolean;
	};
	workspace: {
		hold(
			db: Database,
			workId: string,
			authorization?: ClaudeRunAuthorization,
		): boolean | ClaudeLease;
		release(
			db: Database,
			workId: string,
			confirmed: boolean,
			lease?: ClaudeLease,
		): void;
		released?(db: Database, lease: ClaudeLease): boolean;
		current?(db: Database, lease: ClaudeLease): boolean;
		blocker?(
			db: Database,
			workId: string,
		): { ownerRef: string; state: "unknown" | "releasing" } | null;
		recover?(db: Database, lease: ClaudeLease): boolean;
	};
};
