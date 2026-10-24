import type { Capability } from "../contracts";
import type { ProfileRequest } from "./connect";

import type { ChatInput } from "../contracts/chat-input";
export type ProviderName = Capability | "system-one" | "tts-english";
export type Provider = {
	/** External catalog name, retained across renewal when the internal role differs. */
	claimName?: string;
	chatInput?: ChatInput;
	vision?: boolean;
	name: ProviderName;
	baseUrl: string;
	/** Exact inference URL verified from the optional Provider claim. */
	endpoint?: string;
	model: string;
	protocol: string;
	token: string;
	contextWindow?: {
		maxTokens: number;
		outputReserveTokens: number;
		safetyMarginTokens: number;
	};
	voice?: string;
};
export type Lease = {
	/** Exact original Profile request; periodic use preserves its session scope and revision. */
	request: ProfileRequest;
	id: string;
	expiresAt: number;
	providers: Map<ProviderName, Provider>;
	agentProfile: string;
	useCount: number;
	closing: boolean;
	/** Coalesces cleanup by the last borrower, recovery and close. Kept after a confirmed release. */
	release?: Promise<void>;
	renewTimer?: ReturnType<typeof setTimeout>;
	idleTimer?: ReturnType<typeof setTimeout>;
	idleAt: number;
};
export const protocols: Record<ProviderName, string> = {
	llm: "openai.chat-completions.v1",
	asr: "openai.audio-transcriptions.v1",
	tts: "openai.audio-speech.v1",
	"system-one": "larm.system-one.v1",
	"tts-english": "openai.audio-speech.v1",
};
export const endpoints: Record<ProviderName, string> = {
	llm: "/v1/chat/completions",
	asr: "/v1/audio/transcriptions",
	tts: "/v1/audio/speech",
	"system-one": "/v1/systemone",
	"tts-english": "/v1/audio/speech",
};
export type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;
