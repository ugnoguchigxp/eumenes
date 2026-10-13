import { z } from "zod";
import type {
	SentenceLanguage,
	SentenceLanguageDecision,
} from "./sentence-language";
export {
	sentenceLanguageDecisionSchema,
	sentenceLanguageSchema,
} from "./sentence-language";
export type {
	SentenceLanguage,
	SentenceLanguageDecision,
} from "./sentence-language";
export const speechRoutingSchema = z.object({
	englishTts: z.boolean(),
	languageProviders: z
		.array(z.object({ name: z.string(), model: z.string() }))
		.max(100),
});
export type SpeechRouting = z.infer<typeof speechRoutingSchema>;
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
	/** Explicit execution role; helper calls use independent, short-lived 64K connections. */
	sessionRole?: "main" | "auxiliary";
	speechLanguage?: SentenceLanguage;
	tools?: NativeTool[];
	onToolCalls?: (calls: NativeToolCall[]) => void;
	maxOutputTokens?: number;
	/** Internal control calls only: JSON-object generation at temperature zero. */
	jsonOutput?: boolean;
	contextPolicy?: "exact";
	onExchange?: (exchange: LarmExchange) => Promise<void>;
	speechVoice?: string;
	intonationScale?: number;
	speed?: number;
	pitchScale?: number;
};
export type LarmStatus = {
	state: "unconfigured" | "idle" | "ready" | "connecting" | "failed";
	capabilities: Capability[];
	error?: string;
};
import type { TtsVoices } from "./voices";
export {
	ttsVoicesSchema,
	type TtsVoices,
	type TtsVoice,
	type TtsRange,
} from "./voices";
export interface LarmPort {
	classifySentenceLanguage?(
		text: string,
		signal: AbortSignal,
		options?: LarmCallOptions,
	): Promise<SentenceLanguageDecision>;
	speechRouting?(signal: AbortSignal): Promise<SpeechRouting>;
	decisionModel?(): string | null;
	judge?(
		state: Record<string, string>,
		questions: Record<
			string,
			{ type: "choice"; instructions: string; criteria: Record<string, string> }
		>,
		signal: AbortSignal,
	): Promise<unknown>;
	voices?(signal: AbortSignal, language?: SentenceLanguage): Promise<TtsVoices>;
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
		messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
		signal: AbortSignal,
		onDelta: (text: string) => void,
		options?: LarmCallOptions,
	): Promise<string>;
	answer(
		messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
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

export const larmStatusSchema: z.ZodType<LarmStatus> = z.object({
	state: z.enum(["unconfigured", "idle", "ready", "connecting", "failed"]),
	capabilities: z.array(z.enum(["llm", "asr", "tts"])),
	error: z.string().optional(),
});
export const statusResponseSchema = z.object({
	service: z.string(),
	larm: larmStatusSchema,
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

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
	type MusicTrack,
} from "./music-library";
