import { z } from "zod";
import { jstIso } from "../../../infrastructure/jst-time";
import type { Database } from "bun:sqlite";
import type { Settings, Purpose } from "../../settings/contracts";
import type { SpeechDelivery, SpeechPreparation } from "../../delivery";
export type { ChatImage } from "../../larm";
export type { IntentInput, IntentJudgment, IntentLabel } from "../../larm";
export type Messages = ChatMessage[];
/** How much a model thinks before it answers (`off`: not at all). */
export type ReasoningLevel = "off" | "low" | "medium" | "high";
/** Instruction body excludes the output schema, which is rendered from its value. */
export type ControlContract = {
	instructions: string;
	outputSchema: unknown;
	reasoningEffort?: "low";
};
export function controlInstructions(control: ControlContract) {
	const examples = (control.outputSchema as { examples?: unknown[] } | null)
		?.examples;
	return (
		control.instructions +
		(examples?.length
			? "\nOUTPUT_FORMAT=" + JSON.stringify(examples)
			: "\nOUTPUT_SCHEMA=" + JSON.stringify(control.outputSchema))
	);
}
/** The current time as prompt data: local ISO 8601 with its offset, so the date is never read in UTC. */
export function promptTime(ms: number) {
	return {
		now: jstIso(ms),
		timeZone: "Asia/Tokyo",
	};
}
/**
 * Provider options of a control request: JSON-object generation, plus the output schema when the request was
 * captured with `structuredOutput`. The schema is then enforced as a strict schema (LARM, OpenAI-compatible
 * cloud) or as the agent SDK's output schema. Other control callers' schemas (`z.toJSONSchema`) are not
 * strict-compatible, so their requests stay plain JSON-object generation and the host validates the result.
 */
export function controlJsonOptions(
	control: ControlContract | undefined,
	structuredOutput: boolean,
): { jsonOutput: true; jsonSchema?: Record<string, unknown> } {
	const schema = control?.outputSchema;
	return structuredOutput &&
		schema &&
		typeof schema === "object" &&
		!Array.isArray(schema)
		? { jsonOutput: true, jsonSchema: schema as Record<string, unknown> }
		: { jsonOutput: true };
}
/** One-off voice settings for a sample; never persisted. */
export type SpeechOverride = Partial<
	Pick<
		Settings["larm"],
		"voice" | "style" | "speed" | "pitchScale" | "intonationScale"
	>
>;
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import type {
	ChatInput,
	ChatMessage,
	IntentInput,
	IntentJudgment,
} from "../../larm";
import type { HttpErrorStatus } from "../../../infrastructure/http";
export interface Receipt {
	toolCalls?: NativeToolCall[];
	requestId: string;
	attemptId: string;
	value: string | Uint8Array;
	delivery?: SpeechDelivery;
}
/** Host-issued background authority; independent of a conversation request. */
export interface BackgroundControl {
	taskId: string;
	decisionId: string;
	authorityEpoch: number;
	executionGeneration: number;
	deadline: number;
	taskDeadline: number;
	maxOutputTokens: number;
	/**
	 * `conversation` keeps the saved conversation route; `{ resourceId }` sends the request to that saved
	 * cloud LLM resource (the conversation route when it can not be used); absent means LARM only.
	 */
	route?: "conversation" | { resourceId: string };
	/** Enforce the control output schema as a strict provider schema; absent keeps plain JSON-object output. */
	structuredOutput?: boolean;
}
/**
 * Session lifetime of one call, set by the caller and independent of the request's output mode.
 * `main`: the conversation agent's answer (answer-mode calls only). `subagent`: one task's call (`taskId` required).
 * `auxiliary` (default): a one-shot call.
 */
export type CallSession = {
	sessionRole?: "main" | "subagent" | "auxiliary";
	/** `required`: the only valid output is a call of one of its tools. `none`: a call of `prefixTools` is not valid. */
	toolChoice?: "required" | "none";
	/**
	 * A control call on the conversation's prompt (the ContextWindow layout specification, section 8.2): it is sent
	 * on the conversation's own connection, so the shared prefix is read from its cache, and it yields to the
	 * conversation (a conversation call aborts it with `larm_preempted`). Auxiliary only.
	 */
	onConversation?: true;
	/**
	 * Auxiliary only: the host's own background work (memory and World curation, the agency) on a connection of its
	 * own. It yields like a call on the conversation's prompt: a call made for the user aborts it (`larm_preempted`).
	 * LARM infers one call at a time, so it would otherwise hold the user's call behind it.
	 */
	yields?: true;
	/** With `onConversation`: the conversation's tool definitions, sent unchanged to keep the prefix (`toolChoice: none`). */
	prefixTools?: import("../../../infrastructure/chat-stream").NativeTool[];
	/** This call's own bound on output tokens, below the request's: a call whose output is short by contract. */
	outputLimit?: number;
	/**
	 * With `onConversation`: a read-ahead (the ContextWindow layout specification, section 8.3). It only reads the
	 * prompt into the connection's cache; its output stops at its bound by design and is discarded, so a stream that
	 * ends there is its normal end.
	 */
	readAhead?: true;
	/**
	 * `main` only: how much the model thinks before it answers, one level per target (the conversation harness's
	 * setting; a call may fall back from LARM to the cloud, and the harness follows). An attempt on LARM uses `larm`
	 * (the chat template's thinking switch and the reasoning effort), one on the cloud uses `cloud` (Codex SDK: the
	 * turn's effort). `off` turns thinking off on LARM and sends no effort to the cloud. Its thinking spends the
	 * output bound, so the call's `outputLimit` must leave room for it.
	 */
	reasoning?: { larm: ReasoningLevel; cloud: ReasoningLevel };
	/**
	 * `main` only: the answer is one JSON value of this strict schema (the conversation's local decision call, the
	 * conversation harness design, section 5.3). On LARM it is sent as the strict response format and the native tools
	 * field is left out (the schema names the choices); a cloud attempt passes it as the output schema.
	 */
	outputSchema?: Record<string, unknown>;
	/**
	 * `main` only: answer on the cloud without trying LARM first (a local answer failed the host's checks, section
	 * 5.3). Allowed when the run's route lets a call fall back to the cloud or is cloud-only; otherwise the call fails
	 * with `cloud_fallback_unavailable` before any attempt.
	 */
	target?: "cloud";
	/**
	 * `main` only: a failure of this call ends this call, not the request, so the caller can make another call on the
	 * same request (a local reply that failed the host's checks is answered again on the cloud, section 5.3). Applies
	 * while the caller's signal is not aborted and nothing was published; text a delta function refused (it threw) is
	 * not published.
	 */
	retainRequest?: true;
	/** Hidden auxiliary work on an answer request: publishes no deltas; provider failure ends only this call. */
	failureScope?: "call";
	taskId?: string;
	/**
	 * `main` only. Where the call's messages split, by position: the first `instructionCount` messages are the
	 * instructions; the first `historyCount` user/assistant messages after them are the adopted exchanges stored in
	 * the conversation ledger (the history a session resumes from); every other message is this turn's input.
	 * Providers that cannot resume a session (LARM, Codex, OpenAI-compatible) ignore it and send `messages` whole.
	 */
	context?: { instructionCount: number; historyCount: number };
	/**
	 * What the messages were built from: conversation message ids and memory item ids. Forgetting one of them
	 * revokes the call while it runs (`revokeAgentAttemptsInTransaction`).
	 */
	refs?: {
		messageIds: readonly string[];
		itemIds: readonly string[];
	};
};
/** What a forget purge hands inference: the attempts standing on these references are revoked. */
export type AgentAttemptRevocation = {
	messageIds: readonly string[];
	itemIds: readonly string[];
};
export interface InferencePort {
	captureBackgroundControlInTransaction?(
		db: Database,
		input: BackgroundControl,
	): string;
	countControlTokens?(messages: Messages): number | null;
	captureControlInTransaction?(
		db: Database,
		input: {
			subject: string;
			policySubject: string;
			deadline: number;
			maxOutputTokens: number;
			/** How long one attempt may run, in place of the LARM and cloud defaults (a toolchain's own limit). */
			attemptMs?: number;
		},
	): string;
	/** Move the deadline of a run's requests (subject) later; never earlier. */
	extendDeadlineInTransaction?(
		db: Database,
		subject: string,
		deadline: number,
	): void;
	/** Authorized user action with its own deadline; the caller validates ownership and settles the result. */
	captureUserControlInTransaction?(
		db: Database,
		input: {
			subject: string;
			deadline: number;
			maxOutputTokens: number;
		},
	): string;
	executeControl?(
		requestId: string,
		messages: Messages,
		signal: AbortSignal,
		control?: ControlContract,
		session?: CallSession,
	): Promise<Receipt>;
	rejectControlInTransaction?(
		db: Database,
		receipt: Receipt,
		code: string,
	): void;
	cancelRequestsInTransaction?(db: Database, requestIds: string[]): void;
	/**
	 * Revokes the running (or finished but not yet adopted) agent attempts that stood on a forgotten reference:
	 * they are aborted once the transaction commits and their receipts are refused. Idempotent.
	 */
	revokeAgentAttemptsInTransaction?(
		db: Database,
		input: AgentAttemptRevocation,
	): void;
	/** A task finished (any outcome): drops its agent sessions. Unreleased ones expire (`recover`). */
	releaseTaskSession?(taskId: string): Promise<void>;
	flushCancelledRequests?(requestIds: string[]): void;
	setContextPolicyInTransaction?(
		db: Database,
		requestId: string,
		policy: "exact",
	): void;
	status(): {
		chatInput?: ChatInput;
		state: "unconfigured" | "idle" | "ready" | "connecting" | "failed";
		capabilities: Purpose[];
		error?: string;
	};
	connect?(): Promise<void>;
	prepareVoice?(signal: AbortSignal): Promise<void>;
	answerStream?(
		messages: Messages,
		signal: AbortSignal,
		onDelta: (text: string) => void,
	): Promise<string>;
	answer(messages: Messages, signal: AbortSignal): Promise<string>;
	/**
	 * The user-intent judge of the saved intent profile, on its own LARM connection (the intent gate design,
	 * section 3); it throws when unconfigured or failed, and the caller keeps the existing routing.
	 */
	judgeIntent?(
		input: IntentInput,
		signal: AbortSignal,
	): Promise<IntentJudgment>;
	transcribe(wav: Uint8Array, signal: AbortSignal): Promise<string>;
	speak(
		text: string,
		signal: AbortSignal,
		override?: SpeechOverride,
	): Promise<Uint8Array>;
	speakWithDelivery?(
		text: string,
		signal: AbortSignal,
		preparation?: SpeechPreparation,
	): Promise<{ wav: Uint8Array; delivery?: SpeechDelivery }>;
	close(): Promise<void>;
	captureInTransaction?(
		db: Database,
		subject: string,
		purpose: Purpose,
		deadline: number,
		snapshot?: Settings,
	): string;
	snapshotFor?(db: Database, subject: string): Settings | null;
	bindInTransaction?(
		db: Database,
		voiceSubject: string,
		runSubject: string,
		deadline?: number,
		/** Earlier ASR results merged into this input; each becomes a parent of the answer. */
		transcriptionRequestIds?: string[],
	): void;
	cancelSubject?(subject: string): Promise<void>;
	snapshotInTransaction?(db: Database): Settings;
	/**
	 * The context window (tokens) of the model a captured LLM request is routed to, from its saved settings: the
	 * resource's `contextWindow` on a cloud-only route, the held LARM lease's provider window on a LARM route. null
	 * when it is not known (no lease is held: a claim is made only to serve a call).
	 */
	llmContextWindowInTransaction?(
		db: Database,
		requestId: string,
	): number | null;
	/** The same window from the saved settings now, tied to no request: for a budget that is not a run's. */
	savedLlmContextWindow?(): number | null;
	requestFor?(db: Database, subject: string, purpose: Purpose): string | null;
	executeRequest?(
		requestId: string,
		input: Messages | string | Uint8Array,
		signal: AbortSignal,
		preparation?: SpeechPreparation,
		session?: CallSession,
	): Promise<Receipt>;
	executeStream?(
		requestId: string,
		messages: Messages,
		signal: AbortSignal,
		/**
		 * Receives each piece of the answer. Returning `false` says the caller holds the piece unpublished (a reply
		 * whose head the host checks first): it does not count as published output.
		 */
		onDelta: ((text: string) => void | false) | undefined,
		preparation?: SpeechPreparation,
		tools?: NativeTool[],
		session?: CallSession,
		/** Per-call output constraint; does not change the request's route, mode or authority. */
		outputContract?: ControlContract,
	): Promise<Receipt>;
	captureSpeechChunkInTransaction?(
		db: Database,
		voiceSubject: string,
		index: number,
	): string;
	liveRequest?(id: string): boolean;
	acceptInTransaction?(db: Database, receipt: Receipt): boolean;
	/**
	 * Accepts a pending answer request whose answer the host fixed itself, so no model answer was adopted: the
	 * request is `accepted` with no accepted attempt (that absence is the record; earlier rounds of the run may
	 * have left unaccepted attempts), and what stands on it (speech) proceeds as for a model answer. false: not a
	 * pending answer request that is still allowed, or an attempt of it was already accepted.
	 */
	acceptHostAnswerInTransaction?(db: Database, requestId: string): boolean;
	/** Check a control receipt before delegation without adopting an answer. */
	validateReceiptInTransaction?(db: Database, receipt: Receipt): boolean;
	validRequest?(id: string): boolean;
	validInTransaction?(db: Database, id: string): boolean;
	skipInTransaction?(db: Database, subject: string, purpose: Purpose): void;
}

const exchangeSchema = z.object({
	connectionId: z.string(),
	model: z.string(),
	started: z.number(),
	httpStatus: z.number().optional(),
	errorCode: z.string().optional(),
	errorMessage: z.string().optional(),
	operation: z.string().optional(),
	speechVoice: z.string().optional(),
	speechCredit: z.string().optional(),
});
export const usageSchema = z.object({
	id: z.string(),
	requestId: z.string(),
	subject: z.string(),
	purpose: z.enum(["llm", "asr", "tts"]),
	source: z.string(),
	model: z.string(),
	status: z.string(),
	reason: z.string().nullable(),
	started: z.number(),
	ended: z.number().nullable(),
	accepted: z.number(),
	inputTokens: z.number().nullable(),
	outputTokens: z.number().nullable(),
	/** Who billed the attempt (`BillingPath`); null for attempts recorded before it was kept. */
	billingPath: z.string().nullable().optional(),
	providerDetails: z.array(exchangeSchema).optional(),
});
export type Usage = z.infer<typeof usageSchema>;
export const probeSchema = z.object({
	id: z.string(),
	target: z.string(),
	status: z.string(),
	error: z.string().nullable(),
	revision: z.number(),
	created: z.number(),
});
export const larmDetailsSchema = z.object({
	profile: z.string(),
	connectionId: z.string().optional(),
	providers: z.array(
		z.object({
			name: z.string(),
			model: z.string(),
			baseUrl: z.string(),
			protocol: z.string(),
		}),
	),
});
export const larmProfilesSchema = z.array(
	z.object({ profile: z.string(), model: z.string().nullable() }),
);
/** `GET /api/inference/connections/:id/models`: the models a saved agent connection offers, read at run time. */
export const connectionModelsSchema = z.object({
	models: z.array(
		z.object({
			id: z.string(),
			displayName: z.string(),
			purpose: z.enum(["asr", "tts"]).optional(),
			speech: z
				.object({
					supported: z.boolean(),
					reason: z.string().nullable(),
					voices: z.array(z.string()),
					languages: z.array(z.string()),
					voiceRequired: z.boolean(),
					languageRequired: z.boolean(),
					voiceDefault: z.string().nullable(),
					languageDefault: z.string().nullable(),
					voiceSelectable: z.boolean(),
					languageSelectable: z.boolean(),
				})
				.optional(),
			/** Input context window; null when the provider does not report one (subscription: learned after the first turn). */
			contextWindow: z.number().int().positive().nullable(),
		}),
	),
	/** What the connection's credential resolved to; doubles as the connection test. */
	account: z.object({
		auth: z.enum(["subscription", "api-key"]),
		subscriptionType: z.string().nullable(),
	}),
});
export type ConnectionModels = z.infer<typeof connectionModelsSchema>;
export const startedProbeSchema = z.object({ id: z.string() });
export * from "./record-pages";
export * from "./context-render";
export * from "./context-budget";
/** HTTP status of each code the screen presence report throws. */
export const errorStatus = {
	screen_presence_capacity: 429,
	screen_presence_expired: 409,
} as const satisfies Record<string, HttpErrorStatus>;
