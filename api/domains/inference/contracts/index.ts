import type { Database } from "bun:sqlite";
import type { Settings, Purpose } from "../../settings/contracts";
import type { SpeechDelivery, SpeechPreparation } from "../../delivery";
export type Messages = Array<{
	role: "system" | "user" | "assistant";
	content: string;
}>;
/** One-off voice settings for a sample; never persisted. */
export type SpeechOverride = Partial<
	Pick<
		Settings["larm"],
		"voice" | "style" | "speed" | "pitchScale" | "intonationScale"
	>
>;
export interface Receipt {
	requestId: string;
	attemptId: string;
	value: string | Uint8Array;
	delivery?: SpeechDelivery;
}
export interface InferencePort {
	status(): {
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
	): void;
	cancelSubject?(subject: string): Promise<void>;
	snapshotInTransaction?(db: Database): Settings;
	requestFor?(db: Database, subject: string, purpose: Purpose): string | null;
	executeRequest?(
		requestId: string,
		input: Messages | string | Uint8Array,
		signal: AbortSignal,
		preparation?: SpeechPreparation,
	): Promise<Receipt>;
	executeStream?(
		requestId: string,
		messages: Messages,
		signal: AbortSignal,
		onDelta: (text: string) => void,
	): Promise<Receipt>;
	captureSpeechChunkInTransaction?(
		db: Database,
		voiceSubject: string,
		index: number,
	): string;
	liveRequest?(id: string): boolean;
	acceptInTransaction?(db: Database, receipt: Receipt): boolean;
	validRequest?(id: string): boolean;
	validInTransaction?(db: Database, id: string): boolean;
	skipInTransaction?(db: Database, subject: string, purpose: Purpose): void;
}
