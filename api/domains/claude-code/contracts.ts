import { z } from "zod";
import type {
	ExecutionResult,
	ExecutionSource,
	ToolchainExecutionPort,
	ExecutionStatus,
	ExecutionView,
	TaskLifecyclePort,
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
export type Question = NonNullable<ExecutionView["question"]>;
export type {
	ClaudeObservation as Observation,
	ClaudeStart as Start,
} from "../coding";
import type {
	ClaudeObservation as Observation,
	ClaudeStart as Start,
} from "../coding";
export interface Runner {
	ready(): boolean;
	probe?(): Promise<boolean>;
	start(operation: Start): Promise<Observation>;
	inspect(id: string): Promise<Observation | null>;
	reply(
		id: string,
		operationId: string,
		questionId: string,
		answer: string,
	): Promise<Observation>;
	stop(id: string, operationId: string): Promise<Observation | null>;
}

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
	result: ExecutionResult | null;
	observation: Observation | null;
	calls: number;
	executions: number;
	turnsReserved: number;
	turnsUsedBeforeExecution: number;
	maxCalls: number;
	maxExecutions: number;
	attemptMs: number;
	decisionId: string | null;
	decisionMode: "work" | "progress";
	progressCalls: number;
	progressSeq: number;
	progressAt: number;
	effect:
		| { kind: "start"; operation: Start }
		| { kind: "reply"; id: string; questionId: string; answer: string }
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
};

export type Host = Pick<
	ToolchainExecutionPort,
	"controlSourceInTransaction" | "validReferenceInTransaction"
> & {
	validSourceInTransaction(db: Database, source: ExecutionSource): boolean;
	deliverInTransaction(db: Database, view: ExecutionView, id: string): boolean;
	revokeInTransaction(db: Database, eventId: string): void;
	workspace: {
		hold(db: Database, workId: string): boolean;
		release(db: Database, workId: string, confirmed: boolean): void;
	};
};
