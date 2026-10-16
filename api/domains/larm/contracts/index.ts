import { z } from "zod";
import {
	chatInputSchema,
	type ChatInput,
	type ChatMessage,
} from "./chat-input";
export * from "./chat-input";
export {
	imageArtifactId,
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
	 * Helper calls on LARM use independent, short-lived 64K connections.
	 */
	sessionRole?: "main" | "subagent" | "auxiliary";
	/** `subagent` only: the task whose calls share one agent session. */
	taskId?: string;
	speechLanguage?: SpeechLanguage;
	tools?: NativeTool[];
	onToolCalls?: (calls: NativeToolCall[]) => void;
	maxOutputTokens?: number;
	/** Internal control calls only: JSON-object generation at temperature zero. */
	jsonOutput?: boolean;
	/** Optional schema constraint for internal JSON control calls; host validation remains required. */
	jsonSchema?: Record<string, unknown>;
	/** Optional effort for SDK-backed control tasks; ignored by providers without this option. */
	reasoningEffort?: "low";
	contextPolicy?: "exact";
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
	close(): Promise<void>;
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
