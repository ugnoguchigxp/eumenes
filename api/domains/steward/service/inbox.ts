import type { Database } from "bun:sqlite";
import {
	type MemoryRequestInput,
	type RequestKind,
	type RunEnd,
	memoryRequestInput,
} from "../contracts";
import type { ForgetPurge } from "../../memory";
import {
	countOpenInbox,
	deleteDecisionsByRefs,
	deleteRoutesOfMessages,
	endInboxOfMessages,
	insertInbox,
	readInbox,
} from "../repository";
import type { Kick } from "./kick";
import type { StewardDeps } from "./types";

/** Open requests a conversation may hold. */
const OPEN_REQUESTS = 50;

export type RequestInput = {
	conversationId: string;
	kind: RequestKind;
	what: string;
	detail?: string | undefined;
	/** The user's message the request was made in (a conversation message of this conversation). */
	sourceRef: string;
	/** The id of the tool call: asking again with the same id is a replay and queues nothing. */
	requestId?: string | undefined;
};

/**
 * The request queue (section 13): a request waits as `pending` from the moment the conversation agent's action is
 * committed, and is resolved by the curate step. Cancelling the generation that made it never discards it; the
 * user takes one back with a `withdraw` request. `what` and `detail` are cleared as soon as a request ends.
 */
export function createInbox(deps: StewardDeps, kick: Kick) {
	function requestInTransaction(
		db: Database,
		input: RequestInput,
	): { id: string; replay: boolean } {
		const parsed: MemoryRequestInput = memoryRequestInput.parse({
			kind: input.kind,
			what: input.what,
			...(input.detail ? { detail: input.detail } : {}),
		});
		const id = input.requestId ?? deps.newId();
		const existing = readInbox(db, id);
		if (existing) {
			if (existing.conversationId !== input.conversationId)
				throw new Error("request_conflict");
			return { id: existing.id, replay: true };
		}
		const message = deps.conversation.messageInTransaction(db, input.sourceRef);
		if (
			!message ||
			message.message.role !== "user" ||
			message.message.conversationId !== input.conversationId
		)
			throw new Error("invalid_request_source");
		if (countOpenInbox(db, input.conversationId) >= OPEN_REQUESTS)
			throw new Error("request_queue_full");
		insertInbox(db, {
			id,
			conversationId: input.conversationId,
			sourceRef: input.sourceRef,
			kind: parsed.kind,
			what: parsed.what,
			detail: parsed.detail ?? null,
			createdAt: deps.clock(),
		});
		return { id, replay: false };
	}

	/**
	 * A conversation run ended (inside the transaction that ends it): the steward looks again. The requests the run
	 * made were queued when they were committed, whatever way the run ended; the steward does not act on them before
	 * the run is over, so a forget never expires the answer that announced it.
	 */
	function runEndedInTransaction(
		db: Database,
		input: { runId: string; conversationId: string; state: RunEnd },
	) {
		kick.kickInTransaction(db, input.conversationId);
	}

	/**
	 * A forget (section 6.2): decisions that touched the forgotten items or messages go, and open requests that stand on
	 * the forgotten messages end with their words cleared. The goals a forget names in `derived.goalIds` are deleted
	 * here too (F11): the memory hands the same ids again for every block journal line at startup, so a database
	 * restored from before the forget loses them again before the first answer. Idempotent.
	 */
	function purge(
		db: Database,
		purged: Pick<ForgetPurge, "itemIds" | "messageIds" | "derived">,
	) {
		const goalIds = purged.derived.goalIds ?? [];
		if (goalIds.length > 0 && deps.goals)
			deps.goals.ops.forgetGoalsInTransaction(db, {
				goalIds: [...goalIds],
				entityIds: [],
			});
		deleteDecisionsByRefs(db, {
			itemIds: purged.itemIds,
			messageIds: purged.messageIds,
			goalIds,
		});
		endInboxOfMessages(db, purged.messageIds, "forgotten", deps.clock());
		// What was judged of the forgotten messages goes too. The goal reflection and the memory reflection still due
		// for their events find the events forgotten when they are read (they are given up there).
		deleteRoutesOfMessages(db, purged.messageIds);
	}
	return {
		requestInTransaction,
		runEndedInTransaction,
		purge,
	};
}
