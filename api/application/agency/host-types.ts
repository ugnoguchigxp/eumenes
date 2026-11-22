import type { Database } from "bun:sqlite";
import type { LlmPort, LlmRequest } from "eumenes-agency";
import type { ContinuityService } from "../../domains/continuity";
import type { ConversationService } from "../../domains/conversation";
import type { MemoryService } from "../../domains/memory";
import type { Settings } from "../../domains/settings";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { SpeechRouter } from "./speech";
import type { AgencyCallIdentity } from "./llm-port";
import type {
	AgencyStatePort,
	MemoryTargetRequest,
} from "../../domains/dialogue";
import type { SteeringInbox } from "eumenes-steer";
import type {
	GoalDesigner,
	GoalHostEvent,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import type { HostResult } from "eumenes-memory-host";
export type AgencySettings = Settings["agency"];
export type HostPersona = Pick<
	Settings["general"],
	"agentName" | "userName" | "persona"
>;
/**
 * A research note as a document of the Markdown domain: saved as a Markdown file (and in the document library when it
 * is connected) as the note arrives, so the notes are kept there when the agent's own list lets them go; a note the
 * reply shows is put on a message of the conversation, whose screen shows it.
 */
export type NoteDocumentPort = {
	/** Starts saving the note as a document and returns the document's id; the same note is the same document. */
	startInTransaction(
		db: Database,
		note: {
			conversationId: string;
			noteId: string;
			title: string;
			markdown: string;
			/** When the note was made: the day its document is filed under. */
			at: number;
		},
	): string;
	/** Reads the original accepted body, including while its external save is pending. */
	readInTransaction(
		db: Database,
		id: string,
	): { title: string; markdown: string } | null;
	/** `pending` while it is saved; then the document's resource, or why there is none. */
	stateInTransaction(
		db: Database,
		id: string,
	): "pending" | { uri: string; label: string } | { code: string };
	/** Puts the document on a message of the conversation (the message's chip). */
	linkInTransaction(
		db: Database,
		input: {
			conversationId: string;
			messageId: string;
			uri: string;
			label: string;
		},
	): void;
	/** The notes were forgotten: their documents are no longer offered. */
	forget(conversationId: string, noteIds: readonly string[]): void;
};

export type AgencyHostDeps = {
	state?: AgencyStatePort;
	agendaGoals?: {
		store: GoalStore;
		mockDir: string;
		readMemory(
			method: "context" | "read",
			params: unknown,
		): Promise<HostResult>;
		isGoalContextCurrent(snapshotId: string, db?: Database): boolean;
		/** The messages a goal stands on (a goal resting on a forgotten or excluded one is not shown). */
		sourceMessageIds?(db: Database, goalId: string): readonly string[];
		designer?: GoalDesigner;
		analysisMs?: number;
		trace?(event: GoalHostEvent): void;
	};
	/** Keeps and shows research notes as Markdown documents; absent: notes are not kept and cannot be shown. */
	noteDocuments?: NoteDocumentPort;
	routeSpeechInTransaction?: SpeechRouter;
	store: Pick<SqliteStore, "read" | "write" | "onCommit">;
	conversation: Pick<
		ConversationService,
		| "get"
		| "changesInTransaction"
		| "outboxHeadInTransaction"
		| "sourceInTransaction"
		| "imageReferencesInTransaction"
		| "latestOrdinalInTransaction"
		| "appendInTransaction"
	>;
	/** `foregroundBusy()` serves the user right now (conversation answers, ASR, TTS); background calls never count. */
	inference: {
		foregroundBusy(): boolean;
		onActivity?(listener: () => void): () => void;
	};
	settings: {
		get(): { agency: AgencySettings; general: HostPersona };
		/** The committed settings as the transaction sees them (the delivery fence reads this, not the cache). */
		inTransaction(db: Database): {
			agency: AgencySettings;
			general: HostPersona;
		};
		onChange(listener: () => void): () => void;
	};
	/**
	 * The user's State items are the topic material (hostTopics mode); its immediate operations are what the records
	 * writer and the target resolution write with (the memory domain's public operations).
	 */
	memory: Pick<
		MemoryService,
		| "status"
		| "list"
		| "check"
		| "stateItemsInTransaction"
		| "rememberExplicitInTransaction"
		| "recordCandidateInTransaction"
		| "correctExplicitInTransaction"
		| "excludeForForgetInTransaction"
		| "suppressInTransaction"
		| "suppressionsInTransaction"
		| "policyRevisionInTransaction"
	> &
		Partial<
			Pick<
				MemoryService,
				| "referenceInputs"
				| "isBlockedInTransaction"
				| "blockMessagesInTransaction"
			>
		> & {
			/** The messages among these the memory withholds now (forgotten, or excluded while a forget is on its way). */
			withheldMessagesInTransaction?(
				db: Database,
				messageIds: readonly string[],
			): Iterable<string>;
		};
	/**
	 * The steward's inbox. A request to correct, forget or suppress a target named in words waits there until the agency
	 * resolves it (`pendingTargetsInTransaction`) and settles it; a forget whose targets were excluded waits there for its
	 * closure delete (`excludedInTransaction`, false when it is not a pending forget).
	 */
	steward?: {
		excludedInTransaction(
			db: Database,
			input: {
				id: string;
				conversationId: string;
				exclusion: {
					itemIds: string[];
					messageIds: string[];
					claimIds: string[];
					entityIds: string[];
					goalIds: string[];
				};
			},
		): boolean;
		pendingTargetsInTransaction(
			db: Database,
			input?: { conversationId?: string },
		): ReadonlyArray<{ id: string; request: MemoryTargetRequest }>;
		settleTargetInTransaction(
			db: Database,
			input: { id: string; outcome: "applied" | "unresolved" },
		): unknown;
	};
	/** The dialogue domain's side of a resolved target (built after the agency: read when used). */
	dialogueTargets?: {
		/** The messages the excluded records stand on leave the recent conversation, the summaries and the history reads. */
		hideExcludedInTransaction(
			db: Database,
			input: { messageIds: readonly string[]; itemIds?: readonly string[] },
		): void;
		/** The conversation's requests without a reference are settled: its next generation may go on. */
		targetsSettled(conversationId: string): void;
	};
	/** The plans (L3) and the question ledger the records writer writes and the agent reads. */
	continuity: Pick<ContinuityService, "plans" | "questions" | "events">;
	backgroundDiagnostic?(
		db: Database,
		conversationId: string,
	): { text: string; digest: string } | null;
	/**
	 * Builds the background LLM port of one conversation. `next` names each call (unique decision id, the
	 * conversation's current execution generation); the host wraps the port to log.
	 */
	createLlm(
		next: (request: LlmRequest<unknown>) => AgencyCallIdentity,
	): LlmPort;
	/** True when the conversation has a queued or running run (inside a transaction, read-only). */
	conversationBusy(db: Database, conversationId: string): boolean;
	/** A specialist has the conversation and handles its requests and replies. */
	awaitingWorkConfirmation?(db: Database, conversationId: string): boolean;
	backgroundPaused?(db: Database, conversationId: string): boolean;
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
	/**
	 * The server's one steering inbox (eumenes-steer): words the user sends while a reply is written reach the reply's
	 * next model call. Absent: they wait for a reply of their own.
	 */
	steering?: SteeringInbox;
	/** Which capability a research ticket runs on (the revision id in the catalog); absent: the web note toolchain. */
	researchRevision?(
		catalog: ReadonlyArray<{
			revisionId: string;
			requiresApproval: boolean;
			effect?: string | null;
		}>,
	): string | undefined;
	/** Tells the screens something they show changed outside a database commit (the agent's thoughts). */
	publish?(): void;
	nowMs?(): number;
	setTimer?(fn: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
};
