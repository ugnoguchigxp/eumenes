import { z } from "zod";
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
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
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
}
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
			engine?: "codex_luna";
		},
	): string;
	executeControl?(
		requestId: string,
		messages: Messages,
		signal: AbortSignal,
	): Promise<Receipt>;
	rejectControlInTransaction?(
		db: Database,
		receipt: Receipt,
		code: string,
	): void;
	cancelRequestsInTransaction?(db: Database, requestIds: string[]): void;
	flushCancelledRequests?(requestIds: string[]): void;
	setContextPolicyInTransaction?(
		db: Database,
		requestId: string,
		policy: "exact",
	): void;
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
		validation?: { validationRequestIds: string[] },
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
		preparation?: SpeechPreparation,
		tools?: NativeTool[],
	): Promise<Receipt>;
	captureSpeechChunkInTransaction?(
		db: Database,
		voiceSubject: string,
		index: number,
	): string;
	liveRequest?(id: string): boolean;
	acceptInTransaction?(db: Database, receipt: Receipt): boolean;
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
export type Probe = z.infer<typeof probeSchema>;
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
export type LarmDetails = z.infer<typeof larmDetailsSchema>;
export const startedProbeSchema = z.object({ id: z.string() });
