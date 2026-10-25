import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ContinuityService } from "../../continuity";
import type { ConversationService } from "../../conversation";
import type { GoalAccess, GoalsService } from "../../goals";
import type { MemoryService } from "../../memory";
import type { WorldCuration } from "../../world";
import type { DecisionRefType } from "../repository";
import type { WorldViewReader } from "./world-view";
import type {
	ChatMessage,
	ControlReceipt,
	InferencePort,
	QueuePort,
	RunLookup,
	StepId,
	UnitSlot,
} from "../contracts";
import type { UnitRow, UnitTargets } from "../repository";

/** What the steward uses of memory: the block ledger, the save contract, the forget, the vectors and the Window. */
type StewardMemory = Pick<
	MemoryService,
	| "readyInTransaction"
	| "blockedMessageIdsInTransaction"
	| "forgetSeqInTransaction"
	| "applyCurationInTransaction"
	| "stateItemsInTransaction"
	| "forgetInTransaction"
	| "registerForgetPurge"
	| "vectors"
	| "tendencies"
	| "recallTurnsInRead"
	| "windows"
	| "publishWindowInTransaction"
	| "republishWindowInTransaction"
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
	 * The prefix the conversation's generations send (system, tool definitions, document), looked up at each use
	 * (the application binds it after the dialogue exists). The steps that read the conversation send it before
	 * their task, on the conversation's connection; absent or null keeps their own prompt.
	 */
	conversationPrefix?: () =>
		| ((
				db: Database,
				conversationId: string,
		  ) => { messages: ChatMessage[]; tools: NativeTool[] } | null)
		| undefined;
	/** A conversation run is generating an answer now (upkeep waits for it); read in the caller's transaction. */
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
			/** The window version the step stands on (the episode steps: a re-construction since makes them stale). */
			windowVersion: number | null;
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
	/** A reflecting step changed something: the upkeep revision moves on. */
	changed: boolean;
	/** The profile should be published anew at the next re-construction. */
	requestRepublish?: boolean;
	/** An upkeep step found nothing to change. */
	quiet?: boolean;
	/** A forget ran: the decision keeps no body. */
	redact?: boolean;
	/** The result cannot be adopted (a conflict the step found while applying). */
	stale?: string;
	/** Nothing in the answer could be applied: it counts like an unusable answer. */
	unusable?: boolean;
}

export interface PreparedUnit {
	unit: UnitRow;
	step: StepId;
	data: unknown;
	context: unknown;
	targets: UnitTargets;
	windowVersion: number | null;
}

export type ExecuteContext = {
	signal: AbortSignal;
	deps: StewardDeps;
};

export interface StepDefinition {
	id: StepId;
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

export interface StewardInput {
	unitId: string;
	jobId: string;
	conversationId: string;
	step: StepDefinition;
	requestId: string;
	prepared: PreparedUnit;
	messages: ChatMessage[];
	startedAt: number;
}
export interface StewardOutput {
	receipt: ControlReceipt;
	/** null: the answer was not usable output at all. */
	output: unknown | null;
	extras: unknown;
	outputTokens: number | null;
	durationMs: number;
}
