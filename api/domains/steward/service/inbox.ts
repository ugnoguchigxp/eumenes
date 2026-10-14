import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	type InboxState,
	type MemoryRequestInput,
	type RequestKind,
	type RunEnd,
	memoryRequestInput,
} from "../contracts";
import {
	countOpenInbox,
	deleteDecisionsByRefs,
	deleteSummaryDecisions,
	endInboxOfMessages,
	inboxOfRun,
	insertInbox,
	readInbox,
	resolveInbox,
	setInboxPending,
	stagedRuns,
} from "../repository";
import type { Kick } from "./kick";
import type { StewardDeps } from "./types";

const log = getLogger("steward");
/** Requests one run may leave, and open requests a conversation may hold. */
const REQUESTS_PER_RUN = 8;
const OPEN_REQUESTS = 50;

export type StageInput = {
	/** The id of the tool call (the adapter's request id): staging the same id again is a replay. */
	requestId: string;
	conversationId: string;
	runId: string;
	/** The user message of the run. */
	messageId: string;
	kind: RequestKind;
	what: string;
	detail?: string | undefined;
};

/** Section 2.5: which of a run's staged requests go on, by how the run ended. */
function confirmed(end: RunEnd, kind: RequestKind): boolean {
	if (end === "completed" || end === "failed" || end === "interrupted")
		return true;
	// A cancelled answer still keeps what the user asked to remember (K14); nothing else.
	return end === "cancelled" && kind === "remember";
}

/**
 * The request queue: `staged` while the run lives, `pending` once the run ended in a way that keeps them,
 * resolved by the curate step. `what` and `detail` are cleared as soon as a request ends.
 */
export function createInbox(deps: StewardDeps, kick: Kick) {
	function stageRequestInTransaction(
		db: Database,
		input: StageInput,
	): { id: string; replay: boolean } {
		const parsed: MemoryRequestInput = memoryRequestInput.parse({
			kind: input.kind,
			what: input.what,
			...(input.detail ? { detail: input.detail } : {}),
		});
		const existing = readInbox(db, input.requestId);
		if (existing) {
			if (
				existing.conversationId !== input.conversationId ||
				existing.runId !== input.runId
			)
				throw new Error("request_conflict");
			return { id: existing.id, replay: true };
		}
		const message = deps.conversation.messageInTransaction(db, input.messageId);
		if (
			!message ||
			message.message.role !== "user" ||
			message.message.conversationId !== input.conversationId
		)
			throw new Error("invalid_request_source");
		if (
			countOpenInbox(db, input.conversationId, input.runId) >= REQUESTS_PER_RUN
		)
			throw new Error("too_many_requests");
		if (countOpenInbox(db, input.conversationId) >= OPEN_REQUESTS)
			throw new Error("request_queue_full");
		insertInbox(db, {
			id: input.requestId,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: input.messageId,
			kind: parsed.kind,
			what: parsed.what,
			detail: parsed.detail ?? null,
			createdAt: deps.clock(),
		});
		return { id: input.requestId, replay: false };
	}

	/** A staged request as the tool reports it (never its words). */
	function requestInTransaction(
		db: Database,
		id: string,
	): { id: string; kind: RequestKind; state: InboxState } | null {
		const row = readInbox(db, id);
		return row ? { id: row.id, kind: row.kind, state: row.state } : null;
	}

	/** Confirms or discards the staged requests of one run. Returns how many went on. */
	function settleRun(db: Database, runId: string, end: RunEnd): number {
		const now = deps.clock();
		let pending = 0;
		for (const row of inboxOfRun(db, runId, "staged")) {
			if (confirmed(end, row.kind)) {
				setInboxPending(db, row.id);
				pending++;
			} else
				resolveInbox(
					db,
					row.id,
					"discarded",
					end === "cancelled" ? "run_cancelled" : "run_stale",
					now,
				);
		}
		return pending;
	}

	/** A conversation run ended (inside the transaction that ends it): its requests are settled, then the steward is kicked. */
	function runEndedInTransaction(
		db: Database,
		input: { runId: string; conversationId: string; state: RunEnd },
	) {
		settleRun(db, input.runId, input.state);
		kick.kickInTransaction(db, input.conversationId);
	}

	/**
	 * At startup: staged requests of runs that are no longer running (the process died before their end) are sorted
	 * by the same table. A run still active keeps its requests staged.
	 */
	function sweepStagedInTransaction(db: Database): number {
		let swept = 0;
		for (const runId of stagedRuns(db)) {
			const state = deps.runStateOf(runId);
			if (state === "active") continue;
			swept += settleRun(db, runId, state);
		}
		if (swept > 0) log.info("steward.requests_swept", { count: swept });
		return swept;
	}

	/**
	 * A forget (section 6.2): decisions that touched the forgotten items or messages go, and open requests that stand on
	 * the forgotten messages end with their words cleared. Idempotent: it runs again for every block journal line at startup.
	 */
	function purge(
		db: Database,
		purged: {
			itemIds: readonly string[];
			messageIds: readonly string[];
			/** Conversations whose summary the forget deleted: the decisions that wrote it go with it. */
			deletedSummaryConversationIds: readonly string[];
		},
	) {
		deleteDecisionsByRefs(db, purged);
		deleteSummaryDecisions(db, purged.deletedSummaryConversationIds);
		endInboxOfMessages(db, purged.messageIds, "forgotten", deps.clock());
	}
	return {
		stageRequestInTransaction,
		requestInTransaction,
		runEndedInTransaction,
		sweepStagedInTransaction,
		purge,
	};
}
