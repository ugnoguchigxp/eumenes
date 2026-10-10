import type { Database } from "bun:sqlite";
import { z } from "zod";
export const submitSchema = z.object({
	requestId: z.uuid(),
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().min(1).max(8000),
	utteranceId: z.string().min(1).max(120).optional(),
});
export type Submit = z.infer<typeof submitSchema>;
/** Public HTTP input: voice runs are created only by voice-dialogue, never by clients. */
export const publicSubmitSchema = submitSchema
	.omit({ utteranceId: true })
	.strict();
export type PublicSubmit = z.infer<typeof publicSubmitSchema>;
export const runSchema = z.object({
	id: z.string(),
	agentTaskId: z.string().nullable().optional(),
	requestId: z.string(),
	conversationId: z.string(),
	utteranceId: z.string().nullable(),
	status: z.enum([
		"queued",
		"running",
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	]),
	revision: z.number().int(),
	inputMessageId: z.string(),
	answerMessageId: z.string().nullable(),
	error: z.string().nullable(),
	jobId: z.string().nullable(),
	deadlineAt: z.string().nullable(),
	sourceKind: z.enum(["manual", "voice", "schedule"]),
	scheduleId: z.string().nullable(),
	occurrenceId: z.string().nullable(),
	/**
	 * P3-08: World was read for this run, or World refused (`worldBlocked`).
	 * Explicit and sticky: a World-using run never streams or speaks its body
	 * before adoption, and a blocked run is a failure, never "World not used".
	 */
	worldUsed: z.boolean().optional(),
	worldBlocked: z.boolean().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type Run = z.infer<typeof runSchema>;
export const progressSchema = z.object({
	runId: z.string(),
	status: runSchema.shape.status,
	/** Empty while a World-using run is unadopted; the complete adopted body once. */
	text: z.string().max(65_536),
	worldUsed: z.boolean().optional(),
	worldBlocked: z.boolean().optional(),
	/** Machine-readable end reason of a failed run (never body text). */
	error: z.string().nullable().optional(),
});
export type RunProgress = z.infer<typeof progressSchema>;
export const promptTargetSchema = z.object({
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().min(1).max(8000),
	deadlineMs: z.number().int().min(10_000).max(600_000).optional(),
});
export type PromptTarget = z.infer<typeof promptTargetSchema>;

/** Optional post-answer hook owned by dialogue. It never receives message text. */
export type PostAnswerObservation = {
	runId: string;
	ticketId: string;
	reportEpoch: number;
};
export type PostAnswerObserverResult =
	| { status: "recorded" }
	| { status: "skipped"; code: string };
export interface PostAnswerObserverPort {
	/** Called inside a SAVEPOINT after the answer is adopted; must be synchronous. */
	recordInTransaction(
		db: Database,
		input: PostAnswerObservation,
	): PostAnswerObserverResult;
}

/**
 * Optional World context owned by dialogue's caller (the Context Broker).
 * Dialogue knows no World types: it passes the opaque `context` back and
 * treats the block as reference data in its own labelled message. With no
 * port, or a port answering `disabled`, dialogue behaves as it always did.
 */
export type WorldContextPrepareInput = {
	runId: string;
	conversationId: string;
	jobId: string;
	attempt: number;
	generation: number;
	/** Bytes of reference data already fixed for this input (Memory's recall block). */
	reservedBytes: number;
	nowMs: number;
};
export type WorldContextPrepared =
	| { status: "disabled" }
	/** The run ends with `reason`; it is never continued without the context. */
	| { status: "blocked"; reason: string }
	| { status: "ready"; block: string; context: unknown };
export type WorldContextVerdict =
	| { ok: true }
	/** `retryable`: the check could not run (busy/closing writer); a later attempt may pass. */
	| { ok: false; reason: string; retryable?: boolean };
export type WorldContextSettleInput = {
	runId: string;
	conversationId: string;
	jobId: string;
	attempt: number;
	generation: number;
	inference: { requestId: string; attemptId: string } | null;
	nowMs: number;
};
export interface WorldContextPort {
	/** Same Writer transaction as the Memory recall. Writes nothing unless `ready`. */
	prepareInTransaction(
		db: Database,
		input: WorldContextPrepareInput,
	): WorldContextPrepared;
	/** Just before the model is called; not ok means nothing is sent. */
	checkBeforeSend(context: unknown): Promise<WorldContextVerdict>;
	/** Adoption check in the Writer transaction; read-only. */
	validateInTransaction(
		db: Database,
		input: WorldContextSettleInput,
		context: unknown,
	): WorldContextVerdict;
	/** Same transaction as the answer message, after every check passed. */
	recordUsageInTransaction(
		db: Database,
		input: WorldContextSettleInput,
		context: unknown,
	): void;
	/** The run does not adopt: drop its usage record and input dependencies. */
	releaseInTransaction(
		db: Database,
		runId: string,
		conversationId: string,
	): void;
}
