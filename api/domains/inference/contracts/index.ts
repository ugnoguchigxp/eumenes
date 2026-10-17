import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { Settings, Purpose } from "../../settings/contracts";
import type { SpeechDelivery, SpeechPreparation } from "../../delivery";
export type { ChatImage } from "../../larm";
export type Messages = ChatMessage[];
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
		now: new Date(ms + 9 * 3_600_000).toISOString().replace("Z", "+09:00"),
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
import type { ChatInput, ChatMessage } from "../../larm";
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
		/** The conversation the prompt belongs to: deleting its summary revokes the call (`deletedSummaryConversationIds`). */
		conversationId?: string;
	};
};
/** What a forget purge hands inference: the attempts standing on these references are revoked. */
export type AgentAttemptRevocation = {
	messageIds: readonly string[];
	itemIds: readonly string[];
	/** Conversations whose summary was deleted (the field name is memory's `ForgetPurge`). */
	deletedSummaryConversationIds: readonly string[];
};
export interface InferencePort {
	codexResearchAvailable?(): boolean;
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
			engine?: "codex";
			/** `larm-only` (default) or the saved cloud LLM resource task sub-agents run on (see `BackgroundControl.route`). */
			route?: "larm-only" | { resourceId: string };
		},
	): string;
	/** Authorized user action with its own deadline; the caller validates ownership and settles the result. */
	captureUserControlInTransaction?(
		db: Database,
		input: { subject: string; deadline: number; maxOutputTokens: number },
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
		onDelta: (text: string) => void,
		preparation?: SpeechPreparation,
		tools?: NativeTool[],
		session?: CallSession,
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
