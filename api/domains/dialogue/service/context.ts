import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { MemoryService } from "../../memory";
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
	};
	actionResultIndex?: number;
	authorizedUrls?: string[];
	runId: string;
	revision: number;
	messages: ChatMessage[];
	requestId?: string;
	/** The memory view fixed at prepare time; re-checked in the adoption transaction. */
	memory?: { view: unknown };
	/** The World context fixed at prepare time (opaque here); re-checked before sending and at adoption. */
	world?: { context: unknown };
	/** World was read for this run (this or an earlier attempt): its body is held until adoption. */
	worldUsed?: boolean;
	agent?: AnswerTicket;
}
export interface Accept {
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
	delegation?: import("../contracts/delegation").DelegationPort;
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
	postAnswer?: PostAnswerObserverPort;
	worldContext?: WorldContextPort;
};
