import { z } from "zod";
export type Capability = "llm" | "asr" | "tts";
export type LarmExchange = {
	connectionId: string;
	model: string;
	started: number;
	httpStatus?: number;
	errorCode?: string;
	errorMessage?: string;
	speechVoice?: string;
	speechCredit?: string;
};
export type LarmCallOptions = {
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
	decisionModel?(): string | null;
	judge?(
		state: Record<string, string>,
		questions: Record<
			string,
			{ type: "choice"; instructions: string; criteria: Record<string, string> }
		>,
		signal: AbortSignal,
	): Promise<unknown>;
	voices?(signal: AbortSignal): Promise<TtsVoices>;
	status(): LarmStatus;
	onChange?(listener: () => void): () => void;
	inspect?(): {
		profile: string;
		decisionModel?: string | null;
		connectionId?: string;
		providers: Array<{
			name: Capability;
			model: string;
			baseUrl: string;
			protocol: string;
		}>;
	};
	probe?(signal: AbortSignal): Promise<void>;
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
