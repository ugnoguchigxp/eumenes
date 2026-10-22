import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { MemoryService, PreparedWindow } from "../../memory";
import {
	RESEARCH_BUDGET,
	type AgentRuntime,
	type AnswerTicket,
} from "../../agent-runtime";
import type {
	Addressee,
	GoalsLayerPort,
	Run,
	SpecialistPort,
	StewardPort,
	Viewing,
	WorldContextPort,
} from "../contracts";

import type { CurrentRequest } from "./request-context";
import type { MusicPort } from "../contracts/music";
import type { ImagePort } from "../contracts/image";
import type { ObjectRecognitionPort } from "../contracts/object-recognition";
import type { CommandInteractions } from "./command-interactions";
export const GENERATE_KIND = "dialogue.generate";
/** A toolchain's command sub-agent: one typed operation from the conversation's request. */
export const COMMAND_KIND = "dialogue.toolchain_command";
/** One turn of a specialist session: the user talks to the toolchain's specialist directly. */
export const SPECIALIST_KIND = "dialogue.specialist_turn";
/** The generation job; a command sub-agent's clarifying question travels as data. */
export type GeneratePayload = {
	runId: string;
	commandNote?: string;
	/**
	 * Set when a specialist handed the user's request back (out of its scope): the host line the
	 * main agent reads before it answers. Unlike a command note it leaves the toolchain offer on.
	 */
	specialistHandoff?: string;
};
/** `epoch` fixes the addressee the turn was accepted for; `request` is the first turn's handed-over request. */
export type SpecialistTurnPayload = {
	runId: string;
	epoch: number;
	request?: string;
};
export const PROMPT_TARGET_KIND = "dialogue.prompt";
export const DEFAULT_DEADLINE_MS = RESEARCH_BUDGET.rootMilliseconds;
export const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
	attachments?: import("../../conversation/contracts").Attachment[];
	sourceMessageId?: string;
	images?: import("../../inference").ChatImage[];
};
export interface GenerateInput {
	executionNotice?: import("./execution-notices").ExecutionNoticeBinding;
	executionNoticeReply?: string;
	/** Conversational prose is a short spoken reply; artifact bodies keep their own contract. */
	briefReply?: boolean;
	currentRequest: CurrentRequest;
	/**
	 * A new conversation decision: the execute phase analyzes the request, then answers it or
	 * retrieves candidate toolchains for its goal and offers them as functions. Absent while
	 * phrasing an operation's result.
	 */
	routing?: {
		/** What the first round (the request analysis) reads besides the current request. */
		offeredRevisionIds?: string[];
		retained?: import("./retained-toolchains").PreparedToolchains;
		analysis: import("./request-analysis").AnalysisInput;
		tasks?: import("./initial-decision").TaskOffer;
		/** Toolchains whose runtime is available on this host now. */
		available: string[];
		conversationId: string;
		utteranceId: string | null;
		requestId: string | null;
		/** Questions a toolchain's command sub-agent asked and the user has not answered yet. */
		openQuestions: import("./conversation-tools").OpenQuestion[];
		/** A continuation run: its discovery searches this purpose instead of offering the retained toolchains. */
		continuation?: { need: string };
	};
	/**
	 * A delegated step's result is being phrased for a user's request: before the answer, the conversation checks
	 * it against the request's original text and either finishes or names what is still missing.
	 */
	completionCheck?: CompletionCheck;
	actionResultIndex?: number;
	/** Media result replies have no host-granted URLs; hold and check the body before showing it. */
	mediaResult?: true;
	/** A saved operation is being phrased; its result context must remain in the prompt. */
	operationResult?: true;
	runId: string;
	revision: number;
	messages: ChatMessage[];
	/**
	 * Where `messages` splits for a provider that resumes a session (see `CallSession.context`): the leading
	 * instruction layers (system, long-term, goals) and the adopted exchanges stored in the conversation ledger.
	 */
	sessionContext?: { instructionCount: number; historyCount: number };
	requestId?: string;
	/**
	 * What is left (tokens) of the memory and history budget of the model window after this prompt was assembled:
	 * the per-turn recall fills at most this. Absent: the whole budget less the prefetch.
	 */
	memoryRoomTokens?: number;
	/** The memory window fixed at prepare time; re-checked in the adoption transaction. */
	memory?: {
		window: PreparedWindow;
		/**
		 * The window adds nothing to the prompt (no layer text, no notice): its body is shown as it streams and
		 * the window is checked at adoption only when a recalled exchange stands on it.
		 */
		quiet?: true;
		/**
		 * The shown messages that were already blocked at prepare time (scheduled prompts). A shown message that
		 * is blocked at adoption and not listed here was forgotten meanwhile: the answer is not adopted, quiet or not.
		 */
		blockedAtPrepare?: string[];
	};
	/**
	 * The goals the layer listed, fixed at prepare time; present only when it listed goals. At adoption a
	 * forgotten (deleted) one ends the run as `memory_stale` (see `goalsLayerStale`).
	 */
	goals?: import("./goals-layer").PreparedGoals;
	agent?: AnswerTicket;
}
export interface Accept {
	attachmentIds?: string[];
	requestId: string;
	conversationId: string;
	text: string;
	presentation?: "conversation" | "artifact";
	utteranceId?: string;
	sourceKind: Run["sourceKind"];
	scheduleId?: string;
	occurrenceId?: string;
	deadlineMs?: number;
	voiceSubject?: string;
	transcriptionRequestIds?: string[];
	/**
	 * The run resumes an interaction's command sub-agent: its job is the command job, not a
	 * conversation decision (the toolchain was already chosen when the question was asked).
	 */
	resume?: { interactionId: string; toolchainRevisionId: string };
	/** The saved item the screen shows; kept with the run and shown to the main agent only if issued. */
	viewing?: Viewing;
	/** The addressee the sender saw; checked in the acceptance transaction. */
	addressee?: Addressee;
	/** A continuation run's place in its request's chain (`sourceKind: "continuation"` only). */
	continuation?: Omit<
		import("../repository").Continuation,
		"runId" | "createdAt"
	>;
}
/** What the completion check of one delegated step reads besides the answer's prompt. */
export type CompletionCheck = {
	/** The user's own text of the request; the summaries the conversation wrote are never the standard. */
	originalRequest: string;
	/** The human run the chain started from. */
	rootRunId: string;
	/** Steps of this request before this one (0 for the first) and what they achieved. */
	hop: number;
	achieved: string;
	/** The request's conditions the chain's first check fixed (absent at the first step). */
	conditions?: string[];
	/** The chain's steps up to this one, with this step's results as the conversation received them. */
	steps: import("../repository").PriorStep[];
	/** The condition each continuation step was taken for (the first step served none): each is tried once. */
	attempts: Array<{ step: number; condition: string }>;
};

/** Everything the dialogue service parts share: the injected ports. */
export type DialogueDeps = {
	store: SqliteStore;
	conversation: ConversationService;
	larm: InferencePort;
	queue: QueueService;
	clock: () => string;
	id: () => string;
	memory?: MemoryService;
	/** Told in the transaction in which a run ends, after its exchange is in memory's ledger. */
	steward?: StewardPort;
	agents?: AgentRuntime;
	music?: MusicPort;
	excalidraw?: ImagePort;
	image?: ImagePort;
	objectRecognition?: ObjectRecognitionPort;
	delegation?: import("../contracts/delegation").DelegationPort;
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
	worldContext?: WorldContextPort;
	/** The adopted goals, shown as a layer right after L1. Without it no goals layer exists. */
	goals?: GoalsLayerPort;
	/** Session toolchains and their domain work; without it no specialist session exists. */
	specialist?: SpecialistPort;
	/** Set by `createDialogueService` once intake exists (it accepts the resumed runs). */
	interactions?: CommandInteractions;
	/** Set by `createDialogueService` once intake exists: accepts a continuation run of a user's request. */
	continueInTransaction?: (
		db: import("bun:sqlite").Database,
		input: {
			conversationId: string;
			text: string;
			continuation: NonNullable<Accept["continuation"]>;
		},
	) => Run;
	/** Installed by the voice delivery owner; awaited after publishing, before any operation starts. */
	deliverAnnouncement?: (run: Run, signal: AbortSignal) => Promise<void>;
};
