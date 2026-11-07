import type { Database } from "bun:sqlite";
import type {
	AgencyRuntime,
	IdlePlanner,
	Opportunity,
	createIdleScheduler,
	LlmPort,
	LlmRequest,
	InputContext,
} from "eumenes-agency";
import type { Messages } from "../../domains/inference";
import type { ConversationService } from "../../domains/conversation";
import type { MemoryService } from "../../domains/memory";
import type { Settings } from "../../domains/settings";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { SpeechRouter } from "./speech";
import type { AgencyCallIdentity } from "./llm-port";
import type { AgencyStatePort } from "../../domains/dialogue";
export type AgencySettings = Settings["agency"];
export type HostPersona = Pick<
	Settings["general"],
	"agentName" | "userName" | "persona"
>;
export type AgencyHostDeps = {
	state?: AgencyStatePort;
	routeSpeechInTransaction?: SpeechRouter;
	store: Pick<SqliteStore, "read" | "write" | "onCommit">;
	conversation: Pick<
		ConversationService,
		| "changesInTransaction"
		| "outboxHeadInTransaction"
		| "sourceInTransaction"
		| "latestOrdinalInTransaction"
		| "appendInTransaction"
	>;
	/** `foregroundBusy()` serves the user right now (conversation answers, ASR, TTS); background calls never count. */
	inference: { foregroundBusy(): boolean };
	settings: {
		get(): { agency: AgencySettings; general: HostPersona };
		/** The committed settings as the transaction sees them (the delivery fence reads this, not the cache). */
		inTransaction(db: Database): {
			agency: AgencySettings;
			general: HostPersona;
		};
		onChange(listener: () => void): () => void;
	};
	/** The user's State items are the topic material (hostTopics mode). */
	memory: Pick<MemoryService, "status" | "list"> &
		Partial<Pick<MemoryService, "referenceInputs" | "isBlockedInTransaction">>;
	/** Frozen conversation prefix and State, including all host input dependencies. */
	captureContext?(
		conversationId: string,
	): { messages: Messages; input: InputContext } | null;
	/**
	 * Builds the background LLM port of one conversation. `next` names each call (unique decision id, the
	 * conversation's current execution generation); the host wraps the port to log.
	 */
	createLlm(
		next: (request: LlmRequest<unknown>) => AgencyCallIdentity,
	): LlmPort;
	/** True when the conversation has a queued or running run (inside a transaction, read-only). */
	conversationBusy(db: Database, conversationId: string): boolean;
	/** Records the agency's utterance as an event of the conversation, in the transaction that stores it. */
	recordSpokeInTransaction(
		db: Database,
		input: {
			conversationId: string;
			messageId: string;
			text: string;
			at: string;
			/** The TODOs it cited (a question it asks for the work). */
			todoRefs?: readonly string[];
		},
	): void;
	nowMs?(): number;
	setTimer?(fn: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
};

export type Conv = {
	epoch: number;
	reviewTimer?: unknown;
	id: string;
	/** Unique per runtime instance: ticket ids restart per runtime, message ids must not repeat. */
	scope: string;
	runtime: AgencyRuntime;
	planner: IdlePlanner;
	scheduler: ReturnType<typeof createIdleScheduler>;
	generation: number;
	background: AbortController | null;
	preparedContext?: Messages;
	/** Used by ephemeral hosts without a durable state port. */
	lastDispatchAt?: number;
	opportunities: number;
	calls: number;
	/** Last time the conversation had an event or a cycle (for forgetting idle conversations). */
	touched: number;
	/** The questions of TODOs the agent was last given an opportunity for. */
	reportable: Set<string>;
};

export type Cycle = {
	c: Conv;
	runtime: AgencyRuntime;
	planner: IdlePlanner;
	trigger: Opportunity["trigger"];
	controller: AbortController;
	mine: number;
	ordinal: number;
};
