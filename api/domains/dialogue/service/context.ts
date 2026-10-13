import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { MemoryService, PreparedWindow } from "../../memory";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import {
	RESEARCH_BUDGET,
	type AgentRuntime,
	type AnswerTicket,
} from "../../agent-runtime";
import type {
	PostAnswerObserverPort,
	Run,
	WorldContextPort,
} from "../contracts";

export const GENERATE_KIND = "dialogue.generate";
/** A toolchain's command sub-agent: one typed operation from the conversation's request. */
export const COMMAND_KIND = "dialogue.toolchain_command";
/** The generation job; a command sub-agent's clarifying question travels as data. */
export type GeneratePayload = { runId: string; commandNote?: string };
export const PROMPT_TARGET_KIND = "dialogue.prompt";
export const DEFAULT_DEADLINE_MS = RESEARCH_BUDGET.rootMilliseconds;
export const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

/** The World pre-send check could not run (busy or closing writer): the queue may retry. */
export class WorldContextRetry extends Error {}

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
	attachments?: import("../../conversation/contracts").Attachment[];
	sourceMessageId?: string;
	images?: import("../../inference").ChatImage[];
};
export interface GenerateInput {
	tools?: NativeTool[];
	/**
	 * A new conversation decision: the execute phase retrieves candidate toolchains for this
	 * request and offers them as functions. Absent while phrasing an operation's result.
	 */
	routing?: {
		/** The current utterance with a short excerpt of the preceding turns. */
		query: string;
		/** Toolchains whose runtime is available on this host now. */
		available: string[];
		conversationId: string;
		utteranceId: string | null;
		requestId: string | null;
		/** Questions a toolchain's command sub-agent asked and the user has not answered yet. */
		openQuestions: import("./conversation-tools").OpenQuestion[];
	};
	actionResultIndex?: number;
	runId: string;
	revision: number;
	messages: ChatMessage[];
	requestId?: string;
	/** The memory window fixed at prepare time; re-checked in the adoption transaction. */
	memory?: {
		window: PreparedWindow;
		/**
		 * The window adds nothing to the prompt (no layer text, no notice): its body is shown as it streams and
		 * the window is checked at adoption only when a recalled exchange stands on it.
		 */
		quiet?: true;
	};
	/** The World context fixed at prepare time (opaque here); re-checked before sending and at adoption. */
	world?: { context: unknown };
	/** World was read for this run (this or an earlier attempt): its body is held until adoption. */
	worldUsed?: boolean;
	agent?: AnswerTicket;
}
export interface Accept {
	attachmentIds?: string[];
	requestId: string;
	conversationId: string;
	text: string;
	utteranceId?: string;
	sourceKind: Run["sourceKind"];
	scheduleId?: string;
	occurrenceId?: string;
	deadlineMs?: number;
	voiceSubject?: string;
	validationRequestIds?: string[];
	transcriptionRequestIds?: string[];
	/**
	 * The run resumes an interaction's command sub-agent: its job is the command job, not a
	 * conversation decision (the toolchain was already chosen when the question was asked).
	 */
	resume?: { interactionId: string; toolchainRevisionId: string };
}

/** Everything the dialogue service parts share: the injected ports. */
export type DialogueDeps = {
	store: SqliteStore;
	conversation: ConversationService;
	larm: InferencePort;
	queue: QueueService;
	clock: () => string;
	id: () => string;
	memory?: MemoryService;
	agents?: AgentRuntime;
	music?: import("../contracts/music").MusicPort;
	excalidraw?: import("../contracts/image").ImagePort;
	image?: import("../contracts/image").ImagePort;
	objectRecognition?: import("../contracts/object-recognition").ObjectRecognitionPort;
	delegation?: import("../contracts/delegation").DelegationPort;
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
	postAnswer?: PostAnswerObserverPort;
	worldContext?: WorldContextPort;
	/** Set by `createDialogueService` once intake exists (it accepts the resumed runs). */
	interactions?: import("./command-interactions").CommandInteractions;
};
