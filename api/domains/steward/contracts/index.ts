import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { NativeTool } from "../../../infrastructure/chat-stream";

/** The one queue job kind of the steward: one job is one step, one inference. */
export const STEWARD_KIND = "steward.step.v1";
export const STEWARD_SCOPE = "steward";
export const STEWARD_RESOURCE = "inference.aux";

/**
 * `summarize` prepares the episode summary of the oldest logged events (and of unsummarized marks); `refine-summary`
 * prepares the one summary that merges consecutive shown episode parts. Both write the prepared episode of
 * `continuity`; a re-construction applies it.
 */
const stepIds = [
	"curate-memory",
	"curate-goals",
	"curate-world",
	"summarize",
	"consolidate-memory",
	"consolidate-goals",
	"refine-summary",
] as const;
export type StepId = (typeof stepIds)[number];
const unitKinds = [
	"events",
	"requests",
	"maintenance",
	"world_events",
] as const;
export type UnitKind = (typeof unitKinds)[number];
/**
 * Which open unit a conversation may hold at once: reflecting steps (they read the handled events of the
 * continuity flow), upkeep steps, the World curation (the events World received) and the
 * episode preparation (summaries and merges that the next re-construction applies).
 */
export type UnitSlot = "reflect" | "maintenance" | "world" | "episode";
export type UnitState = "open" | "applied" | "stale" | "failed";

/**
 * `withdraw` takes back a request that was not applied yet (the user changed their mind); an applied forget is
 * never undone.
 */
export const requestKinds = [
	"forget",
	"remember",
	"correct",
	"goal",
	"withdraw",
] as const;
export type RequestKind = (typeof requestKinds)[number];
/** A request waits as `pending` from the moment the conversation agent's action is committed. */
export type InboxState = "pending" | "done" | "none";
/** How a conversation run ended (the dialogue tells the steward, which only takes it as a reason to look again). */
export type RunEnd =
	| "completed"
	| "failed"
	| "interrupted"
	| "cancelled"
	| "stale";
/** What the application knows of a run: `active` is still running; an unknown run is `stale`. */
export type RunLookup = "active" | RunEnd;

/** The conversation agent's memory tool `request` input (dialogue validates it and calls the steward directly). */
const WHAT_MAX_CHARS = 500;
const DETAIL_MAX_CHARS = 1000;
export const memoryRequestInput = z.strictObject({
	kind: z.enum(requestKinds),
	what: z.string().trim().min(1).max(WHAT_MAX_CHARS),
	detail: z.string().trim().max(DETAIL_MAX_CHARS).optional(),
});
export type MemoryRequestInput = z.infer<typeof memoryRequestInput>;

export const payloadSchema = z.object({ unitId: z.string().min(1) });
export type StewardPayload = z.infer<typeof payloadSchema>;

// ---- limits (section 2.3, 2.4) ----

/** Events one step reads, and the input bytes they and the requests' source messages may fill together. */
export const EVENTS_PER_UNIT = 8;
export const UNIT_INPUT_BYTES = 16 * 1024;
/** The events one episode summary may read (the oldest logged events, or the parts of a merge). */
export const EPISODE_INPUT_BYTES = 48 * 1024;
/** The consecutive shown parts one merge may span. */
export const MERGE_PARTS = 4;
/** The quiet time before a re-construction (section 12.3): no new event for this long. */
export const SILENCE_WAIT_MS = 10_000;
/** A gap of at least this long between two events is a break in the talk (section 8.3). */
export const SILENCE_BREAK_MS = 120_000;
export const REQUESTS_PER_UNIT = 8;
/** One message handed to the steward: longer ones keep the head and the tail. */
export const MESSAGE_HEAD_BYTES = 4096;
export const MESSAGE_TAIL_BYTES = 2048;
export const MESSAGE_MAX_BYTES = MESSAGE_HEAD_BYTES + MESSAGE_TAIL_BYTES;
/** Failed units over the same target after which the target is given up (section 2.3). */
export const MAX_FAILURES = 3;
export const DECISIONS_PER_CONVERSATION = 1000;
/** Closed units kept per conversation (the failure counts of upkeep read the recent ones). */
export const UNITS_PER_CONVERSATION = 300;
/** Upkeep: most steps in one round, and the waits while a foreground run is active. */
export const MAINTENANCE_STEPS_PER_ROUND = 3;
/** A step the conversation took its connection from waits this long before it is made again (it is not a failure). */
export const PREEMPTED_WAIT_MS = 15_000;
/** Upkeep runs only after this long without a conversation event: it never competes with the conversation. */
export const MAINTENANCE_QUIET_MS = 10 * 60 * 1000;
export const FOREGROUND_DELAYS_MS = [30_000, 120_000, 600_000] as const;
/** Waits before a failed target is tried again (indexed by earlier failures). */
export const RETRY_DELAYS_MS = [0, 15_000, 60_000] as const;
/** The wait before the first retry of a step whose inference request could not be taken, and its ceiling (it doubles). */
export const CAPTURE_RETRY_MS = 30_000;
export const CAPTURE_RETRY_MAX_MS = 5 * 60_000;
/**
 * The control request's deadline and output cap (inference allows a structured request 90 s and
 * 1500 tokens). The cloud fallback reserves up to 60 s of the deadline, so LARM gets about 30 s.
 */
export const INFERENCE_MS = 90_000;
export const MAX_OUTPUT_TOKENS = 1200;
export const MAX_OUTPUT_BYTES = 32 * 1024;
/** The queue deadline of a job: it covers waiting behind earlier jobs and the retries. */
export const JOB_DEADLINE_MS = 5 * 60_000;
/** The episode is merged when it takes this share of its section limit. */
export const MERGE_THRESHOLD = 0.9;

// ---- ports the application provides (queue and inference are lower than the steward's callers) ----

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};
/**
 * A call on the conversation's prompt (the ContextWindow layout specification, section 8.2): it runs on the
 * conversation's connection with the conversation's tools (not to be called), so the shared prefix is read from
 * the cache, and it yields to the conversation (`larm_preempted`).
 */
export type ConversationSession = {
	sessionRole: "auxiliary";
	onConversation: true;
	prefixTools: NativeTool[];
	toolChoice: "none";
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
			/**
			 * "conversation": keep the conversation's own route (cloud allowed) instead of forcing the local one;
			 * `{ resourceId }`: that saved cloud LLM resource.
			 */
			route?: "conversation" | { resourceId: string };
			/** The output schema goes to the provider as a strict schema. */
			structuredOutput?: boolean;
		},
	): string;
	executeControl(
		requestId: string,
		messages: ChatMessage[],
		signal: AbortSignal,
		control?: { instructions: string; outputSchema: unknown },
		session?: ConversationSession,
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
type StewardJobClaim<P> = {
	jobId: string;
	generation: number;
	attempt: number;
	payload: P;
};
type StewardSettleOutcome<O> =
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

const decisionSchema = z.object({
	id: z.number(),
	conversationId: z.string(),
	jobId: z.string(),
	step: z.enum(stepIds),
	createdAt: z.string(),
	/** The normalized output; null for a step that was not adopted, and after a forget touched it. */
	output: z.unknown(),
	results: z.unknown(),
	windowVersionBefore: z.number().nullable(),
	windowVersionAfter: z.number().nullable(),
	durationMs: z.number().nullable(),
	outputTokens: z.number().nullable(),
	errorCode: z.string().nullable(),
});
export type DecisionDto = z.infer<typeof decisionSchema>;
export const decisionsResponseSchema = z.object({
	items: z.array(decisionSchema),
});
export const decisionsQuerySchema = z.object({
	conversationId: z.string().min(1).max(120),
	limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const eventsQuerySchema = z.object({
	conversationId: z.string().min(1).max(120),
});
