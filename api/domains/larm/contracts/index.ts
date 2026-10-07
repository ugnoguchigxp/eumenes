export type Capability = "llm" | "asr" | "tts";
export type LarmStatus = {
	state: "unconfigured" | "ready" | "connecting" | "failed";
	capabilities: Capability[];
	error?: string;
};
export interface LarmPort {
	status(): LarmStatus;
	answer(
		messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
		signal: AbortSignal,
	): Promise<string>;
	transcribe(wav: Uint8Array, signal: AbortSignal): Promise<string>;
	speak(text: string, signal: AbortSignal): Promise<Uint8Array>;
	close(): Promise<void>;
}
