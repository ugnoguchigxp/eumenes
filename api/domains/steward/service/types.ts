import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ContinuityService } from "../../continuity";
import type { ConversationService } from "../../conversation";
import type { MemoryService } from "../../memory";
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

/** What the steward uses of memory: the ledgers, the save contract, the forget, the vectors and the Window. */
export type StewardMemory = Pick<
	MemoryService,
	| "readyInTransaction"
	| "pendingExchangesInTransaction"
	| "exchangeInTransaction"
	| "exchangesInTransaction"
	| "exchanges"
	| "markExchangeStepInTransaction"
	| "recordExchangeFailureInTransaction"
	| "setDispositionInTransaction"
	| "summaryInTransaction"
	| "summaryRevisionInTransaction"
	| "writeSummaryInTransaction"
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
>;

export interface StewardDeps {
	store: SqliteStore;
	memory: StewardMemory;
	conversation: ConversationService;
	continuity: ContinuityService;
	queue: QueuePort;
	inference: InferencePort;
	/** A conversation run is generating an answer now (upkeep waits for it). */
	foregroundActive(conversationId: string): boolean;
	/** How a run stands (startup sorts the requests of finished runs). */
	runStateOf(runId: string): RunLookup;
	clock(): string;
	nowMs(): number;
	newId(): string;
}

/** The transaction a step reads and writes in. */
export interface StepEnv {
	db: Database;
	deps: StewardDeps;
	conversationId: string;
}

export type PrepareResult =
	| { status: "stale"; reason: string }
	| {
			status: "ready";
			/** The data object the model reads. */
			data: unknown;
			/** The targets that fit; rewritten into the unit. */
			targets: UnitTargets;
			/** The summary revision the step stands on (steps that read the summary). */
			summaryRevision: number | null;
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
	refs: Array<{ type: "item" | "message" | "request"; id: string }>;
	notices: string[];
	/** A reflecting step changed something: the upkeep revision moves on. */
	changed: boolean;
	republishLongTerm?: boolean;
	prefetch?: { text: string; pins: { messageId: string; digest: string }[]; bytes: number };
	/** An upkeep step found nothing to change. */
	quiet?: boolean;
	/** A forget ran: the decision keeps no body. */
	redact?: boolean;
	/** The result cannot be adopted (a conflict the step found while applying). */
	stale?: string;
}

export interface PreparedUnit {
	unit: UnitRow;
	step: StepId;
	data: unknown;
	context: unknown;
	targets: UnitTargets;
	summaryRevision: number | null;
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
	outputSchema: unknown;
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
