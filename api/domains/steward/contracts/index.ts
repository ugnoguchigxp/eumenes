import type { Database } from "bun:sqlite";
import { z } from "zod";

/** The one queue job kind of the steward: one job is one step, one inference. */
export const STEWARD_KIND = "steward.step.v1";
export const STEWARD_SCOPE = "steward";
export const STEWARD_RESOURCE = "inference.aux";

export const stepIds = [
	"curate-memory",
	"dispose-exchanges",
	"summarize",
	"prepare-recall",
	"consolidate-memory",
	"compact-history",
	"refine-summary",
] as const;
export type StepId = (typeof stepIds)[number];
export const unitKinds = ["exchange_step", "requests", "maintenance"] as const;
export type UnitKind = (typeof unitKinds)[number];
/** Which open unit a conversation may hold at once: reflecting steps, upkeep steps, the recall preparation. */
export type UnitSlot = "reflect" | "maintenance" | "recall";
export type UnitState = "open" | "applied" | "stale" | "failed";

export const requestKinds = ["forget", "remember", "correct"] as const;
export type RequestKind = (typeof requestKinds)[number];
export type InboxState = "staged" | "pending" | "done" | "none" | "discarded";
/** How a conversation run ended (the dialogue tells the steward); a replaced run is `stale`. */
export type RunEnd =
	| "completed"
	| "failed"
	| "interrupted"
	| "cancelled"
	| "stale";
/** What the application knows of a run at startup: `active` is still running; an unknown run is `stale`. */
export type RunLookup = "active" | RunEnd;

/** The conversation agent's `memory_request` input (the tool's own schema is registered in capabilities). */
export const WHAT_MAX_CHARS = 500;
export const DETAIL_MAX_CHARS = 1000;
export const memoryRequestInput = z.strictObject({
	kind: z.enum(requestKinds),
	what: z.string().trim().min(1).max(WHAT_MAX_CHARS),
	detail: z.string().trim().max(DETAIL_MAX_CHARS).optional(),
});
export type MemoryRequestInput = z.infer<typeof memoryRequestInput>;

export const payloadSchema = z.object({ unitId: z.string().min(1) });
export type StewardPayload = z.infer<typeof payloadSchema>;

// ---- limits (section 2.3, 2.4) ----

/** Exchanges one step reads, and the input bytes they and the requests' exchanges may fill together. */
export const EXCHANGES_PER_UNIT = 4;
export const UNIT_INPUT_BYTES = 16 * 1024;
export const REQUESTS_PER_UNIT = 8;
/** One message handed to the steward: longer ones keep the head and the tail. */
export const MESSAGE_HEAD_BYTES = 4096;
export const MESSAGE_TAIL_BYTES = 2048;
export const MESSAGE_MAX_BYTES = MESSAGE_HEAD_BYTES + MESSAGE_TAIL_BYTES;
/** Failed units over the same target after which the target is given up (section 2.3). */
export const MAX_FAILURES = 3;
export const DECISIONS_PER_CONVERSATION = 1000;
/** Upkeep: most steps in one round, and the waits while a foreground run is active. */
export const MAINTENANCE_STEPS_PER_ROUND = 3;
export const FOREGROUND_DELAYS_MS = [30_000, 120_000, 600_000] as const;
/** Waits before a failed target is tried again (indexed by earlier failures). */
export const RETRY_DELAYS_MS = [0, 15_000, 60_000] as const;
/** The control request's deadline and output cap (inference refuses more than 30 s / 1500 tokens). */
export const INFERENCE_MS = 25_000;
export const MAX_OUTPUT_TOKENS = 1200;
export const MAX_OUTPUT_BYTES = 32 * 1024;
/** The queue deadline of a job: it covers waiting behind earlier jobs and the retries. */
export const JOB_DEADLINE_MS = 5 * 60_000;
/** The verbatim history budget the compaction is measured against (the dialogue's `HISTORY_MAX_BYTES`). */
export const HISTORY_BUDGET_BYTES = 48 * 1024;
/** One message of the verbatim history is cut here (the dialogue's `HISTORY_MESSAGE_MAX_BYTES`). */
export const HISTORY_MESSAGE_BYTES = 12 * 1024;
/** Mirrors of memory's `LONG_TERM_BYTES` (what the long-term list shown to a step may fill) and `PENDING_LIMIT`. */
export const LONG_TERM_LIST_BYTES = 16 * 1024;
export const PENDING_LIMIT = 5;
export const COMPACT_THRESHOLD = 0.75;
export const REFINE_THRESHOLD = 0.9;

// ---- ports the application provides (queue and inference are lower than the steward's callers) ----

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};
export interface ControlReceipt {
	requestId: string;
	attemptId: string;
	value: string | Uint8Array;
}
export interface InferencePort {
	captureBackgroundControlInTransaction(
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
	executeControl(
		requestId: string,
		messages: ChatMessage[],
		signal: AbortSignal,
		control?: { instructions: string; outputSchema: unknown },
	): Promise<ControlReceipt>;
	acceptInTransaction(db: Database, receipt: ControlReceipt): boolean;
	rejectControlInTransaction(
		db: Database,
		receipt: ControlReceipt,
		code: string,
	): void;
	cancelRequestsInTransaction(db: Database, requestIds: string[]): void;
	flushCancelledRequests(requestIds: string[]): void;
	/** Output tokens of a text, when the application can count them. */
	countControlTokens?(messages: ChatMessage[]): number | null;
}
export interface QueuePort {
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
			availableAtMs?: number;
			deadlineAtMs: number;
		},
	): { job: { id: string }; fresh: boolean };
}
/** The queue's handler contract, restated for the one handler the steward registers. */
export type StewardJobClaim<P> = {
	jobId: string;
	generation: number;
	attempt: number;
	payload: P;
};
export type StewardSettleOutcome<O> =
	| { type: "success"; result: O; resultRef?: string }
	| { type: "retry"; errorCode: string; availableAtMs: number }
	| { type: "failed"; errorCode: string }
	| { type: "expired" }
	| { type: "interrupted"; errorCode: string };
export interface StewardJobHandler<P, I, O> {
	kind: string;
	payloadVersions: readonly number[];
	schema: z.ZodType<P>;
	recovery: "replay_safe" | "interrupt";
	resourceKey?: string;
	prepareInTransaction(
		tx: Database,
		claim: StewardJobClaim<P>,
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
		claim: StewardJobClaim<P>,
		input: I | null,
		outcome: StewardSettleOutcome<O>,
	): "applied" | "stale" | { status: "failed"; errorCode: string };
	cancelInTransaction(
		tx: Database,
		job: { jobId: string; subjectRef: string | null; payload: P },
		reason: string,
	): void;
}

// ---- read model ----

export interface DecisionDto {
	id: number;
	conversationId: string;
	jobId: string;
	step: StepId;
	createdAt: string;
	/** The normalized output; null for a step that was not adopted, and after a forget touched it. */
	output: unknown;
	results: unknown;
	windowVersionBefore: number | null;
	windowVersionAfter: number | null;
	durationMs: number | null;
	outputTokens: number | null;
	errorCode: string | null;
}
export const decisionsQuerySchema = z.object({
	conversationId: z.string().min(1).max(120),
	limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const exchangesQuerySchema = z.object({
	conversationId: z.string().min(1).max(120),
});
