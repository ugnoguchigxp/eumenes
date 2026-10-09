import type { Capability } from "../contracts";

export type ProviderName = Capability | "system-one";
export type Provider = {
	name: ProviderName;
	baseUrl: string;
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
	id: string;
	expiresAt: number;
	providers: Map<ProviderName, Provider>;
	agentProfile: string;
	useCount: number;
	closing: boolean;
	renewTimer?: ReturnType<typeof setTimeout>;
	idleTimer?: ReturnType<typeof setTimeout>;
	idleAt: number;
};
export const gemmaProfile = "SAAA-gemma4-26b";
export const auxiliaryProfile = "SAAA-gemma4-26b-64k";
export const gemmaAgentProfile = "saaa-conversation-gemma4-26b-voice";
export const gemmaContext = {
	maxTokens: 262144,
	outputReserveTokens: 4096,
	safetyMarginTokens: 1976,
};
export const protocols: Record<ProviderName, string> = {
	llm: "openai.chat-completions.v1",
	asr: "openai.audio-transcriptions.v1",
	tts: "openai.audio-speech.v1",
	"system-one": "larm.system-one.v1",
};
export const endpoints: Record<ProviderName, string> = {
	llm: "/v1/chat/completions",
	asr: "/v1/audio/transcriptions",
	tts: "/v1/audio/speech",
	"system-one": "/v1/systemone",
};
export type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;
