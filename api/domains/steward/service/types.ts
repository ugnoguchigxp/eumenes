import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ContinuityService } from "../../continuity";
import type { ConversationService } from "../../conversation";
import type { GoalAccess, GoalsService } from "../../goals";
import type { MemoryService } from "../../memory";
import type { WorldCuration } from "../../world";
import type { DecisionRefType } from "../repository";
import type { SleepDeps } from "./sleep/ports";
import type { WorldViewReader } from "./world-view";
import type {
	ChatMessage,
	ControlReceipt,
	InferencePort,
	QueuePort,
	RunLookup,
	LlmStepId,
	SleepStepId,
	UnitSlot,
} from "../contracts";
import type { UnitRow, UnitTargets } from "../repository";

/** What the steward uses of memory: the block ledger, the save contract, the forget, the vectors, the Window and the library's access policy. */
type StewardMemory = Pick<
	MemoryService,
	| "readyInTransaction"
	| "policyRevisionInTransaction"
	| "blockedMessageIdsInTransaction"
	| "forgetSeqInTransaction"
	| "applyCurationInTransaction"
	| "writeTendencyInTransaction"
	| "closeExclusionInTransaction"
	| "stateItemsInTransaction"
	| "forgetInTransaction"
	| "registerForgetPurge"
	| "vectors"
	| "tendencies"
	| "recallTurnsInRead"
	| "windows"
	| "publishWindowInTransaction"
	| "windowPlan"
>;

/** What the steward calls of World's curation (the World package owns every rule of what becomes a claim). */
export type StewardWorldCuration = Pick<
	WorldCuration,
	| "pendingEventsInTransaction"
	| "prepareCurationInTransaction"
	| "settleCurationInTransaction"
	| "settleEmptyInTransaction"
	| "giveUpEventsInTransaction"
	| "releaseCurationInTransaction"
	| "acceptSourceForgetInTransaction"
	| "forgetClaimsInTransaction"
	| "forgetEntitiesInTransaction"
	| "evidenceMessagesOf"
	| "forgetEpochInTransaction"
>;
/** World, when the application runs it: absent (World off), everything about World is skipped. */
export interface StewardWorld {
	curation: StewardWorldCuration;
	/** The read side that shows the model World's claims and entities (`createWorldView` over World's public reads). */
	view: WorldViewReader;
	/** Advances an accepted forget; the steward calls it after the transaction that accepted it committed. */
	resumeForget(forgetId: string): Promise<unknown> | unknown;
	/** The one Scope the conversation's World lives in. */
	scope: ScopeRef;
}
/** The goals the steward maintains (the application assembles the service). */
interface StewardGoals {
	ops: Pick<
		GoalsService,
		| "applyInTransaction"
		| "listForStewardInTransaction"
		| "proposalsInTransaction"
		| "resolveForgetInTransaction"
		| "forgetGoalsInTransaction"
	>;
	access: GoalAccess;
}

export interface StewardDeps {
	store: SqliteStore;
	memory: StewardMemory;
	conversation: ConversationService;
	continuity: ContinuityService;
	queue: QueuePort;
	inference: InferencePort;
	/**
	 * The conversation's prompt with a step's `## Task` last (the prefix its generations share, then `## State` and
	 * the task), looked up at each use (the application binds it after the dialogue exists). The steps that read the
	 * conversation run on it and on the conversation's connection; absent or null keeps their own prompt.
	 */
	conversationTask?: () =>
		| ((
				db: Database,
				conversationId: string,
				task: string,
		  ) => { messages: ChatMessage[] } | null)
		| undefined;
	/**
	 * The conversation is served by LARM (not a cloud connection), judged by the conversation's own route decision,
	 * in the caller's transaction. Only then do the steps that read the conversation share its prefix (`conversationTask`);
	 * on a cloud route they send their own input.
	 */
	conversationOnLarm(db: Database): boolean;
	/** A conversation run is generating an answer now (the steward's steps wait for it); read in the caller's transaction. */
	foregroundActive(db: Database, conversationId: string): boolean;
	/** How a run stands (startup sorts the requests of finished runs). */
	runStateOf(runId: string): RunLookup;
	clock(): string;
	nowMs(): number;
	newId(): string;
	/** Runs `run` once after `ms`; the returned function cancels it. Default: an unref'd `setTimeout`. */
	setTimer?(run: () => void, ms: number): () => void;
	/** Absent: World is off, and the World curation, its routing and the World parts of a forget are skipped. */
	world?: StewardWorld;
	/** The saved cloud LLM resource the World curation runs on; absent or null keeps the conversation route. */
	worldResourceId?(): string | null;
	/** Absent: no goal reflection, no goal upkeep, no goal in a forget. */
	goals?: StewardGoals;
	/**
	 * How long the user's last utterance must be past for a conversation to count as resting: the interval the user
	 * chose between the agent's own utterances (`agency.speechIntervalSec`), in milliseconds. The sleep layer and the
	 * World curation start only in a resting conversation.
	 */
	restMs(): number;
	/** Absent: the sleep layer (shallow and deep consolidation) does not start; the closure delete of a forget still runs. */
	sleep?: SleepDeps;
	/** The operational log file the error report reads (`config.logFile`); absent or undefined reads no log. */
	logFile?(): string | undefined;
}

/** The transaction a step reads and writes in. */
export interface StepEnv {
	db: Database;
	deps: StewardDeps;
	conversationId: string;
}

export type PrepareResult =
	| {
			status: "stale";
			reason: string;
			/** Nothing can be done now but may be later: the unit is made again after a wait, not at once. */
			retryLater?: boolean;
	  }
	| {
			status: "ready";
			/** The data object the model reads. */
			data: unknown;
			/** The targets that fit; rewritten into the unit. */
			targets: UnitTargets;
			/** What settle needs and the model never sees (refs, ids, digests). */
			context: unknown;
	  };

/** What a step's apply did, for the decision record and the unit's end. */
export interface ApplyResult {
	applied: number;
	rejected: number;
	/** The normalized output as the decision keeps it. */
	output: unknown;
	/** One entry per element: status and a code, never text. */
	results: unknown;
	refs: Array<{ type: DecisionRefType; id: string }>;
	notices: string[];
	/** A step changed something the Window carries. */
	changed: boolean;
	/** The profile should be published anew. */
	requestRepublish?: boolean;
	/** A forget ran: the decision keeps no body. */
	redact?: boolean;
	/** The result cannot be adopted (a conflict the step found while applying). */
	stale?: string;
	/** Nothing in the answer could be applied: it counts like an unusable answer. */
	unusable?: boolean;
}

export interface PreparedUnit {
	unit: UnitRow;
	step: LlmStepId;
	data: unknown;
	context: unknown;
	targets: UnitTargets;
}

export type ExecuteContext = {
	signal: AbortSignal;
	deps: StewardDeps;
};

export interface StepDefinition {
	id: LlmStepId;
	slot: UnitSlot;
	/** Writes long-term memory: serialized across conversations. */
	longTerm: boolean;
	instructions: string;
	/** The schema the answer must follow: strict, and bound to what this unit offers (the labels it gave). */
	outputSchema(prepared: PreparedUnit): unknown;
	prepare(env: StepEnv, unit: UnitRow): PrepareResult;
	/** The model's text, normalized element by element; null when it is not usable at all. */
	parse(raw: unknown): unknown | null;
	/** Work before the inference: it may extend what the model reads, and start work that runs beside it. */
	beforeInfer?(
		prepared: PreparedUnit,
		ctx: ExecuteContext,
	): Promise<{ data?: unknown; extras?: unknown }>;
	/** Work after a usable answer (embedding the recall query). */
	afterInfer?(
		prepared: PreparedUnit,
		output: unknown,
		extras: unknown,
		ctx: ExecuteContext,
	): Promise<unknown>;
	apply(
		env: StepEnv,
		prepared: PreparedUnit,
		output: unknown,
		extras: unknown,
	): ApplyResult;
}

/** A unit that asks the model once (the explicit requests, the World curation). */
export interface LlmInput {
	kind: "llm";
	unitId: string;
	jobId: string;
	conversationId: string;
	step: StepDefinition;
	requestId: string;
	prepared: PreparedUnit;
	messages: ChatMessage[];
	startedAt: number;
}
/** A sleep-layer unit: it makes its own calls and writes (the library adopts in its own transactions). */
export interface SleepInput {
	kind: "sleep";
	unitId: string;
	jobId: string;
	conversationId: string;
	step: SleepStepDefinition;
	/** What the step's prepare fixed (the plans it was given, the turns it embeds). */
	prepared: unknown;
	/** The memory's forget counter when prepare fenced the unit: a write that finds it moved writes nothing. */
	forgetSeq: number | null;
	/** The unit's targets as prepare left them (what the run was made for, the positions a deep run covers). */
	targets: UnitTargets;
	/** The job's attempt and generation: the model requests it makes are named after them. */
	attempt: number;
	generation: number;
	startedAt: number;
}
export type StewardInput = LlmInput | SleepInput;
export type LlmOutput = {
	kind: "llm";
	receipt: ControlReceipt;
	/** null: the answer was not usable output at all. */
	output: unknown | null;
	extras: unknown;
	outputTokens: number | null;
	durationMs: number;
};
export type SleepOutput = {
	kind: "sleep";
	/** What the step's run produced (its settle adopts what is still to be written in the unit's transaction). */
	result: unknown;
	durationMs: number;
};
export type StewardOutput = LlmOutput | SleepOutput;

/** What a sleep step's settle did, for the decision record. */
export interface SleepSettle {
	/** One entry per kind of change: counts and codes, never text. */
	results: unknown;
	/** The unit failed or yielded without being the targets' fault (a code), or null when it was adopted. */
	failed?: { code: string; count: boolean };
	/** The unit stood on ground that changed (a forget): nothing is adopted. */
	stale?: string;
	refs: ApplyResult["refs"];
}
export interface SleepStepDefinition {
	id: SleepStepId;
	slot: Extract<UnitSlot, "maintenance">;
	/** The queue's concurrency key: sleep units are serialized with the long-term writers, the closure delete is not. */
	concurrencyKey: string;
	/** A unit that does not wait for a conversation run (the closure delete of a forget). */
	urgent: boolean;
	prepare(
		env: StepEnv,
		unit: UnitRow,
	):
		| { status: "ready"; prepared: unknown; targets: UnitTargets }
		| { status: "stale"; reason: string };
	run(
		input: SleepInput,
		ctx: { signal: AbortSignal; deps: StewardDeps },
	): Promise<unknown>;
	settle(env: StepEnv, input: SleepInput, result: unknown): SleepSettle;
}
