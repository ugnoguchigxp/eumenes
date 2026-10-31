import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { MemoryService, PreparedWindow } from "../../memory";
import type { ContinuityService } from "../../continuity";
import {
	RESEARCH_BUDGET,
	type AgentRuntime,
	type AnswerTicket,
} from "../../agent-runtime";
import type {
	Addressee,
	AgencyLayerPort,
	ConversationAgentPort,
	Run,
	SpecialistPort,
	StewardPort,
	RunViewing,
	WorldContextPort,
} from "../contracts";

import type { MusicPort } from "../contracts/music";
import type { ImagePort } from "../contracts/image";
import type { ObjectRecognitionPort } from "../contracts/object-recognition";
import type { CommandInteractions } from "./command-interactions";
import type { ConversationHarness } from "./harness";
import type { ResourceAccess, ResourceLedger } from "./resource-ledger";
import type { ChatImage } from "../../inference";
export const GENERATE_KIND = "dialogue.generate";
/** A toolchain's command sub-agent: one typed operation from the conversation's request. */
export const COMMAND_KIND = "dialogue.toolchain_command";
/** One turn of a specialist session: the user talks to the toolchain's specialist directly. */
export const SPECIALIST_KIND = "dialogue.specialist_turn";
/** The generation job; a command sub-agent's clarifying question travels as data. */
export type GeneratePayload = {
	runId: string;
	/** The earlier generation of this run committed actions and was not adopted (section 13). */
	notAdopted?: boolean;
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
	images?: ChatImage[];
};

/** What the last message of a generation answers: the pending utterances, or a host notice. */
export type FinalMessage =
	| {
			kind: "utterances";
			/** The pending user utterances it shows, in receipt order. */
			seqs: number[];
			messageIds: string[];
	  }
	| { kind: "fixed" };

/** What a generation's prepare fixes, inside the claim transaction. */
/** The host's records a routed turn chooses on, fixed at the claim (the local harness rebuild plan, sections 4.3–4.4). */
export type RoutedInput = {
	/** `## Memory` as the talk turn shows it (the user's own words only), when it shows any item. */
	memory: string | null;
	/** The user's earlier utterances in the talk turn's window, oldest first (cut to their head): what a request may point to. */
	earlier: string[];
	/** `## State` of the choice calls: now, the work by its numbers and what is presented. */
	state: string;
	/** The agent's last words, for 「それ」「さっきの」 (cut to their head). */
	previousReply: string | null;
	/** The request the agent asked about when that question was the last thing said, shortly before. */
	asked: { request: string } | null;
	/** Confirmations not yet answered, and the questions the work asks the user. */
	pending: {
		confirmations: Array<{
			ref: number;
			toolchain: string;
			request: string;
			/** The name of the saved item it changes, as the confirmation showed it. */
			target: string | null;
		}>;
		questions: Array<{ ref: number; title: string; question: string }>;
	};
	/**
	 * The work the choice may name: the open work, which it may check, correct or cancel, and the finished work
	 * `## State` shows, which it may only check.
	 */
	todos: Array<{ ref: number; title: string; open: boolean }>;
	/** The resources `## State` names (`a<n>`): the only ones a choice may hand over with its request. */
	resources: string[];
	/**
	 * The toolchain a hand-over waits for the user's word on, because a suspended work is unsaved (`## State` says
	 * 別の作業への切替の確認待ち): only its branch may carry `resolveUnsaved`.
	 */
	switching: string | null;
};

export interface GenerateInput {
	runId: string;
	/** The run's own input message (the user's request a later generation of the run still acts for). */
	inputMessageId: string;
	/** The newest event seq when it was prepared: what this generation appends comes after it. */
	lastSeq: number;
	/** The generation's queue job: the parent of an agent task it starts. */
	jobId: string;
	revision: number;
	conversationId: string;
	requestId?: string;
	/** The harness this run is composed and called with, chosen when it was prepared and kept to its end. */
	harness: ConversationHarness;
	/**
	 * The system part, `## Memory`, the recent conversation, then the last message (`## State`, `## Host notice`,
	 * `## User`). Tool calls and results are added while it runs.
	 */
	messages: ChatMessage[];
	/** The texts of the pending utterances `## User` shows, in receipt order. */
	utterances: string[];
	/** What a routed turn's choice calls read besides the talk input (the local harness rebuild plan, section 4). */
	routed?: RoutedInput;
	final: FinalMessage;
	/** Why this generation runs (the TODOs that changed, the utterances, a host note). */
	trigger: ReadonlyArray<Record<string, unknown>>;
	/**
	 * The sub-agent's answer this generation speaks about, consumed only when the generation is adopted: a report
	 * whose evidence changed meanwhile (a corrected or withdrawn source) is never adopted.
	 */
	agent?: AnswerTicket;
	/** The TODOs whose result this generation shows (the host notice, and what the work tool read): what a reply may report. */
	shown: { todos: string[] };
	/** The memory items `## Memory` shows: a memory read names them as shown. */
	memoryItemIds: string[];
	/** The host notice of the works this generation reports, in one line: kept with its reply (section 5.5 #4). */
	notice?: string;
	/** Why the recent conversation was cut before this generation (section 6.1.1); null when it was not. */
	cut: string | null;
	/** The input's revision as drawn: a forget or a correction of what it shows meanwhile expires the generation. */
	inputRevision: number;
	/** The TODOs' revisions as `## State` showed them: the work tool acts on what the model saw. */
	todoRevisions: Record<string, number>;
	/** The toolchains this generation may delegate to without a search (`state.retained`). */
	retained: ReturnType<
		import("./work-ledger").WorkLedger["retainedInTransaction"]
	>;
	sessionContext: { instructionCount: number; historyCount: number };
	/** The memory window fixed at prepare time; re-checked in the adoption transaction. */
	memory?: {
		window: PreparedWindow;
		/** The shown messages already blocked at prepare time; one blocked later expires the generation. */
		blockedAtPrepare?: string[];
	};
}
export interface Accept {
	attachmentIds?: string[];
	requestId: string;
	conversationId: string;
	text: string;
	presentation?: "conversation" | "artifact";
	/** The toolchain a screen's form submit named: stored on the run, never offered to the main agent's selection. */
	toolchainId?: string;
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
	viewing?: RunViewing;
	/** The addressee the sender saw; checked in the acceptance transaction. */
	addressee?: Addressee;
}
/** Everything the dialogue service parts share: the injected ports. */
export type DialogueDeps = {
	store: SqliteStore;
	conversation: ConversationService;
	larm: InferencePort;
	queue: QueueService;
	clock: () => string;
	id: () => string;
	/** The active short-term memory: the event log (the work results among it) and the notes. */
	continuity: ContinuityService;
	/** The conversation's TODOs and confirmations; set by `createDialogueService`. */
	work?: import("./work-ledger").WorkLedger;
	/** The resource registry and which kinds a toolchain makes; without it the conversation has no resources. */
	resources?: ResourceAccess;
	/** The conversation's resource ledger (`a<n>`); set by `createDialogueService` when `resources` is given. */
	resourceLedger?: ResourceLedger;
	memory?: MemoryService;
	/** Told in the transaction in which a run ends, after its exchange is in memory's ledger. */
	steward?: StewardPort;
	agents?: AgentRuntime;
	music?: MusicPort;
	excalidraw?: ImagePort;
	image?: ImagePort;
	objectRecognition?: ObjectRecognitionPort;
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
	worldContext?: WorldContextPort;
	/** The operational log file (`config.logFile`) the read tool `read_runs` reads warnings from; absent: none read. */
	logFile?: () => string | undefined;
	/** The agency layer: told when a TODO changed (its opportunity to report). */
	agency?: AgencyLayerPort;
	/** The conversation agent that answers every generation. */
	conversationAgent: ConversationAgentPort;
	/** Session toolchains and their domain work; without it no specialist session exists. */
	specialist?: SpecialistPort;
	/** Set by `createDialogueService` once intake exists (it accepts the resumed runs). */
	interactions?: CommandInteractions;
	/** The context keeper: told of every utterance written to the input (section 7.3). Absent: no keeper runs. */
	contextKeeper?: {
		noteUtterance(conversationId: string, speaker: "user" | "agent"): void;
	};
	/** Installed by the voice delivery owner; awaited after publishing, before any operation starts. */
	/** Plays the announcement; resolves with how much was heard (cut short by the user: partial), rejects when nothing was. */
	deliverAnnouncement?: (
		run: Run,
		signal: AbortSignal,
	) => Promise<"full" | "partial">;
};
