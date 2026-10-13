import type { Database } from "bun:sqlite";
import type { z } from "zod";

/**
 * What the memory agent needs of the queue and of inference. They are declared here, structurally,
 * because memory is a lower domain than both and must not import them; the application wires the real ones.
 */
export type AgentChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};
export interface AgentReceipt {
	requestId: string;
	attemptId: string;
	value: string | Uint8Array;
}
export interface AgentInferencePort {
	captureBackgroundControlInTransaction?(
		db: Database,
		input: {
			taskId: string;
			decisionId: string;
			authorityEpoch: number;
			executionGeneration: number;
			deadline: number;
			taskDeadline: number;
			maxOutputTokens: number;
		},
	): string;
	executeControl?(
		requestId: string,
		messages: AgentChatMessage[],
		signal: AbortSignal,
		control?: { instructions: string; outputSchema: unknown },
	): Promise<AgentReceipt>;
	acceptInTransaction?(db: Database, receipt: AgentReceipt): boolean;
	rejectControlInTransaction?(
		db: Database,
		receipt: AgentReceipt,
		code: string,
	): void;
	cancelRequestsInTransaction?(db: Database, requestIds: string[]): void;
	flushCancelledRequests?(requestIds: string[]): void;
}
export interface AgentQueuePort {
	enqueueInTransaction(
		db: Database,
		input: {
			scope: string;
			kind: string;
			dedupeKey: string;
			payload: unknown;
			subjectRef: string;
			lane: "background";
			resourceKey: string;
			concurrencyKey: string;
			maxAttempts: number;
			deadlineAtMs: number;
		},
	): { job: { id: string }; fresh: boolean };
}

/** The queue's handler contract, restated for the one handler memory registers. */
export type AgentJobClaim<P> = {
	jobId: string;
	generation: number;
	payload: P;
};
export type AgentSettleOutcome<O> =
	| { type: "success"; result: O; resultRef?: string }
	| { type: "retry"; errorCode: string; availableAtMs: number }
	| { type: "failed"; errorCode: string }
	| { type: "expired" }
	| { type: "interrupted"; errorCode: string };
export interface AgentJobHandler<P, I, O> {
	kind: string;
	payloadVersions: readonly number[];
	schema: z.ZodType<P>;
	recovery: "replay_safe" | "interrupt";
	resourceKey?: string;
	prepareInTransaction(
		tx: Database,
		claim: AgentJobClaim<P>,
	): { status: "ready"; input: I } | { status: "stale"; reason: string };
	execute(
		input: I,
		context: {
			signal: AbortSignal;
			jobId: string;
			attempt: number;
			generation: number;
		},
	): Promise<O>;
	classify?(error: unknown): "retry" | "fail";
	settleInTransaction(
		tx: Database,
		claim: AgentJobClaim<P>,
		input: I | null,
		outcome: AgentSettleOutcome<O>,
	): "applied" | "stale" | { status: "failed"; errorCode: string };
	cancelInTransaction(
		tx: Database,
		job: { jobId: string; subjectRef: string | null; payload: P },
		reason: string,
	): void;
}
