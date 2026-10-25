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
	GoalsLayerPort,
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
import type { ResourceAccess, ResourceLedger } from "./resource-ledger";
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
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	attachments?: import("../../conversation/contracts").Attachment[];
	sourceMessageId?: string;
	images?: import("../../inference").ChatImage[];
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
};

/** What the newest message of a generation is (the ContextWindow specification, section 5.1). */
export type FinalMessage =
	| {
			kind: "utterances";
			/** The pending user utterances it shows, in receipt order. */
			seqs: number[];
			messageIds: string[];
	  }
	| { kind: "fixed" };

/** Where the newest message(s) start in a generation's messages: after the system, the document and `<now>`. */
export const NEWEST_MESSAGES_AT = 3;

/** What a generation's prepare fixes, inside the claim transaction. */
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
	/**
	 * System, the material document, `<now>`, then the newest message(s) (from `NEWEST_MESSAGES_AT`). Tool calls and
	 * results are added while it runs.
	 */
	messages: ChatMessage[];
	final: FinalMessage;
	/** Why this generation runs (the triggers its `<now>` shows). */
	trigger: ReadonlyArray<Record<string, unknown>>;
	plan: import("../../inference").WindowPlan;
	/** The rendered document and its sizes (measured, never re-rendered while it runs). */
	document: import("./context-document").ContextDocument;
	/**
	 * The sub-agent's answer this generation speaks about, consumed only when the generation is adopted: a report
	 * whose evidence changed meanwhile (a corrected or withdrawn source) is never adopted.
	 */
	agent?: AnswerTicket;
	/** The TODOs whose result the log shows: what a reply may report. */
	shown: { todos: string[] };
	/** The TODOs' revisions as `<state>` showed them: the work tool acts on what the model saw. */
	todoRevisions: Record<string, number>;
	/** The episode version shown: an episode changed meanwhile by a forget expires the generation. */
	windowVersion: number;
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
	/** The goals the state section listed, fixed at prepare time. */
	goals?: import("./goals-state").PreparedGoals;
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
	/** The active short-term memory: the event log, the episode, the work results, the notes. */
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
	delegation?: import("../contracts/delegation").DelegationPort;
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
	worldContext?: WorldContextPort;
	/** The adopted goals, shown as a layer right after L1. Without it no goals layer exists. */
	goals?: GoalsLayerPort;
	/** The agency layer (its recent own utterances and interests). Without it no agency block exists. */
	agency?: AgencyLayerPort;
	/** The conversation agent that answers every generation. */
	conversationAgent: ConversationAgentPort;
	/** Session toolchains and their domain work; without it no specialist session exists. */
	specialist?: SpecialistPort;
	/** Set by `createDialogueService` once intake exists (it accepts the resumed runs). */
	interactions?: CommandInteractions;
	/** Installed by the voice delivery owner; awaited after publishing, before any operation starts. */
	/** Plays the announcement; resolves with how much was heard (cut short by the user: partial), rejects when nothing was. */
	deliverAnnouncement?: (
		run: Run,
		signal: AbortSignal,
	) => Promise<"full" | "partial">;
};
