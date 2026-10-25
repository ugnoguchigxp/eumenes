import { z } from "zod";
export {
	monitoringSnapshotSchema,
	monitoringEventsSchema,
	monitoringEventSchema,
} from "./monitoring-v1";
export type { MonitoringEvent, MonitoringObservation } from "./monitoring-v1";
import {
	chatInputSchema,
	type ChatInput,
	type ChatMessage,
} from "./chat-input";
export * from "./chat-input";
export {
	imageArtifactId,
	imageArtifact,
	imageArtifactDelete,
	imageLibrary,
} from "./image-library";
/** Selects the Japanese or the English voice for one synthesis. */
type SpeechLanguage = "ja" | "en";
import type { HttpErrorStatus } from "../../../infrastructure/http";
export type Capability = "llm" | "asr" | "tts";
export type LarmExchange = {
	operation?: string;
	connectionId: string;
	model: string;
	started: number;
	httpStatus?: number;
	errorCode?: string;
	errorMessage?: string;
	speechVoice?: string;
	speechCredit?: string;
};
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
export type LarmCallOptions = {
	/** The attempt's own time limit when longer than usual: the stuck-stream guard is never shorter. */
	attemptMs?: number;
	/** One-off synthesis values; reuse the claimed connection. Undefined style explicitly resets it. */
	speechOverride?: {
		voice?: string;
		style?: string;
		speed?: number;
		pitchScale?: number;
		intonationScale?: number;
	};
	/**
	 * Session lifetime of this call, set by the caller (independent of the output mode):
	 * `main` the conversation agent's answer, `subagent` one task (requires `taskId`), `auxiliary` a one-shot call.
	 * Helper calls on LARM use their own connections, one per instruction prefix (see `createHelperConnections`).
	 */
	sessionRole?: "main" | "subagent" | "auxiliary";
	/**
	 * `auxiliary` only: background work on the conversation's prompt. It runs on the conversation's connection (the
	 * shared prefix is in its cache) and yields: a conversation call aborts it (`larm_preempted`).
	 */
	onConversation?: true;
	/** `subagent` only: the task whose calls share one agent session. */
	taskId?: string;
	speechLanguage?: SpeechLanguage;
	/** ASR only: the language code the transcription is fixed to. */
	asrLanguage?: string;
	/**
	 * ASR only: a transcript the provider reports in any other language (lower-case code or English name)
	 * is noise and comes back empty.
	 */
	asrAcceptedLanguages?: string[];
	tools?: NativeTool[];
	/**
	 * `required`: the provider must call one of `tools`; `none`: it must not (the tools only keep the prompt's prefix
	 * the same as the conversation's). Default: it may answer in text.
	 */
	toolChoice?: "required" | "none";
	/** The output is spoken to the user: no fixed temperature, even with `tools`. */
	speaks?: true;
	onToolCalls?: (calls: NativeToolCall[]) => void;
	maxOutputTokens?: number;
	/** Internal control calls only: JSON-object generation at temperature zero. */
	jsonOutput?: boolean;
	/** Optional schema constraint for internal JSON control calls; host validation remains required. */
	jsonSchema?: Record<string, unknown>;
	/** Logical offered functions are represented by the output schema rather than the native tools field. */
	toolOutputFormat?: "json-schema";
	/** Optional effort for SDK-backed control tasks; ignored by providers without this option. */
	reasoningEffort?: "low";
	contextPolicy?: "exact";
	/**
	 * `exact` only: where the adopted history sits in the host-fixed list (the first `instructionCount` messages are
	 * instructions, then `historyCount` user/assistant messages). If the list is over the window, the oldest of
	 * these are dropped first; without it nothing is dropped.
	 */
	history?: { instructionCount: number; historyCount: number };
	onExchange?: (exchange: LarmExchange) => Promise<void>;
	speechVoice?: string;
	intonationScale?: number;
	speed?: number;
	pitchScale?: number;
};
export type LarmStatus = {
	chatInput?: ChatInput;
	state: "unconfigured" | "idle" | "ready" | "connecting" | "failed";
	capabilities: Capability[];
	error?: string;
};
import type { TtsVoices } from "./voices";
export { ttsVoicesSchema, type TtsVoices } from "./voices";
export interface LarmPort {
	decisionModel?(): string | null;
	/**
	 * The context window (tokens) of the LLM provider of the lease held now; null when no lease is held (the
	 * window is part of the provider's claim, and a claim is made only to serve a call).
	 */
	llmContextWindow?(): number | null;
	judge?(
		state: Record<string, string>,
		questions: Record<
			string,
			{ type: "choice"; instructions: string; criteria: Record<string, string> }
		>,
		signal: AbortSignal,
	): Promise<unknown>;
	voices?(signal: AbortSignal, language?: SpeechLanguage): Promise<TtsVoices>;
	status(): LarmStatus;
	onChange?(listener: () => void): () => void;
	inspect?(): {
		profile: string;
		decisionModel?: string | null;
		connectionId?: string;
		providers: Array<{
			name: Capability | "tts-english";
			model: string;
			baseUrl: string;
			protocol: string;
		}>;
	};
	probe?(signal: AbortSignal): Promise<void>;
	/** Read-only: the LLM model each selectable conversation profile publishes in the catalog. */
	conversationProfiles?(
		signal: AbortSignal,
	): Promise<Array<{ profile: string; model: string | null }>>;
	connect(): Promise<void>;
	/** Repeats the existing Profile request while the main chat has a live UI owner. */
	retain?(active: boolean): void;
	prepareVoice?(signal: AbortSignal): Promise<void>;
	answerStream?(
		messages: ChatMessage[],
		signal: AbortSignal,
		onDelta: (text: string) => void,
		options?: LarmCallOptions,
	): Promise<string>;
	answer(
		messages: ChatMessage[],
		signal: AbortSignal,
		options?: LarmCallOptions,
	): Promise<string>;
	transcribe(
		wav: Uint8Array,
		signal: AbortSignal,
		options?: LarmCallOptions,
	): Promise<string>;
	speak(
		text: string,
		signal: AbortSignal,
		options?: LarmCallOptions,
	): Promise<Uint8Array>;
	/**
	 * Ends the port. `keepConnection` (host shutdown) leaves the connections to LARM's expiry so a restarted host
	 * gets them back with their input cache; otherwise they are released.
	 */
	close(options?: { keepConnection?: true }): Promise<void>;
}

const larmStatusSchema: z.ZodType<LarmStatus> = z.object({
	state: z.enum(["unconfigured", "idle", "ready", "connecting", "failed"]),
	capabilities: z.array(z.enum(["llm", "asr", "tts"])),
	chatInput: chatInputSchema.optional(),
	error: z.string().optional(),
});
export const statusResponseSchema = z.object({
	service: z.string(),
	larm: larmStatusSchema,
});

/** HTTP status of each error code this domain throws; merged by `api/application/error-status.ts`. */
export const errorStatus = {
	larm_base_url_unconfigured: 409,
	larm_provider_host_mismatch: 502,
} as const satisfies Record<string, HttpErrorStatus>;

export {
	trackId,
	trackQuery,
	trackQueryParams,
	musicTrack,
	musicTracks,
	musicTags,
	type TrackQuery,
} from "./music-library";
export {
	musicProviders,
	musicGenerationInput,
	type MusicProviders,
} from "./music-generation";
export { imageImportReceipt, type ImageImportReceipt } from "./image-import";
