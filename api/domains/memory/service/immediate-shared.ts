import type { Database } from "bun:sqlite";
import { MemoryContractError } from "eumenes-memory";
import type { StateItem, StateWriteResult } from "eumenes-memory/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import type { ConversationService } from "../../conversation";
import type {
	ImmediateRejection,
	ItemTarget,
	Rejected,
} from "../contracts/immediate";
import { isBlocked } from "../repository";
import type { ContextWindowStore } from "./context-window";
import type { createEvidence } from "./curation-evidence";
import type { CurationDeps } from "./curation-shared";
import { listAllState } from "./state-snapshot";
import { foldedLength, locateQuoteSpan } from "./quote";
import type { ShortRefs } from "./short-refs";

const log = getLogger("memory");

/** What the operations of the immediate layer need from the memory service around them. */
export type ImmediateDeps = CurationDeps & {
	conversation: ConversationService;
	windows: ContextWindowStore;
	shortRefs: ShortRefs;
	evidence: ReturnType<typeof createEvidence>;
};

export const rejected = (reason: ImmediateRejection): Rejected => ({
	status: "rejected",
	reason,
});

/**
 * Runs one operation as a unit inside the caller's writer transaction: a refusal (or an unexpected error) leaves no
 * trace of it, and what the caller did before stays. An unexpected error is a refusal too (`conflict`), logged
 * without text, so one operation never takes the caller's whole transaction (the run's adoption) down.
 */
export function guarded<T extends { status: string }>(
	db: Database,
	run: () => T | Rejected,
): T | Rejected {
	db.exec("SAVEPOINT memory_immediate_op");
	let result: T | Rejected;
	try {
		result = run();
	} catch (error) {
		db.exec("ROLLBACK TO memory_immediate_op");
		db.exec("RELEASE memory_immediate_op");
		if (error instanceof MemoryContractError) return rejected("invalid_input");
		log.warn(
			"memory.immediate_operation_failed",
			{ reason: "unexpected_error" },
			error,
		);
		return rejected("conflict");
	}
	if (result.status === "rejected") db.exec("ROLLBACK TO memory_immediate_op");
	db.exec("RELEASE memory_immediate_op");
	return result;
}

/** Every State item of the profile: inactive and excluded ones too (an operation must see what a forget is removing). */
export function everyItem(
	db: Database,
	deps: Pick<CurationDeps, "scoped">,
	itemIds?: readonly string[],
): readonly StateItem[] {
	const listed = listAllState(db, {
		...deps.scoped(db, "memory.write"),
		includeInactive: true,
		includeExcluded: true,
		...(itemIds ? { itemIds } : {}),
	});
	if (listed.status !== "ok") throw new Error("memory_blocked");
	return listed.items;
}

/** The item as the library holds it now; null when it is unknown or forgotten. */
export function itemOf(
	db: Database,
	deps: Pick<CurationDeps, "scoped">,
	itemId: string,
): StateItem | null {
	if (itemId === "" || itemId.length > 256) return null;
	return everyItem(db, deps, [itemId])[0] ?? null;
}

/** The item (and the version the caller saw, when it saw one) a target names. */
export function resolveTarget(
	db: Database,
	deps: ImmediateDeps,
	conversationId: string,
	target: ItemTarget,
):
	| { ok: true; itemId: string; revision: number | null }
	| { ok: false; reason: ImmediateRejection } {
	if ("ref" in target) {
		if (typeof target.ref !== "string" || target.ref.trim() === "")
			return { ok: false, reason: "invalid_input" };
		const found = deps.shortRefs.resolveInTransaction(
			db,
			conversationId,
			target.ref,
		);
		return found
			? { ok: true, ...found }
			: { ok: false, reason: "unknown_ref" };
	}
	if (typeof target.itemId !== "string" || target.itemId === "")
		return { ok: false, reason: "invalid_input" };
	return { ok: true, itemId: target.itemId, revision: target.revision ?? null };
}

/**
 * The words a record stands on: the user's message of the conversation and the quote, which must be a substring of
 * it (spaces, punctuation and width forms are forgiven, as for every quote). A missing quote is allowed only when
 * `quote` is null (a candidate): then the message itself, bounded, is the evidence.
 */
export function groundedEvidence(
	db: Database,
	deps: ImmediateDeps,
	input: {
		conversationId: string;
		messageId: string;
		quote: string | null;
		hint: string;
	},
):
	| {
			ok: true;
			built: Extract<
				ReturnType<ReturnType<typeof createEvidence>["evidenceFrom"]>,
				{ ok: true }
			>;
	  }
	| { ok: false; reason: ImmediateRejection } {
	const found = deps.conversation.messageInTransaction(db, input.messageId);
	if (
		!found ||
		found.message.conversationId !== input.conversationId ||
		found.message.role !== "user"
	)
		return { ok: false, reason: "invalid_source" };
	if (isBlocked(db, input.messageId))
		return { ok: false, reason: "blocked_source" };
	if (input.quote !== null) {
		const span = locateQuoteSpan(found.message.text, input.quote);
		// Too short to evidence anything.
		if (
			span === null ||
			foldedLength(found.message.text.slice(span.start, span.end)) < 2
		)
			return { ok: false, reason: "quote_mismatch" };
	}
	const built = deps.evidence.evidenceFrom(
		db,
		input.conversationId,
		input.messageId,
		input.quote,
		input.hint,
	);
	if (!built.ok)
		return {
			ok: false,
			reason:
				built.reason === "blocked_source" ? "blocked_source" : "invalid_source",
		};
	return { ok: true, built };
}

/** A refusal of the library's write as the reason the caller reads. */
export function writeRejection(result: StateWriteResult): ImmediateRejection {
	if (result.status !== "rejected") return "conflict";
	switch (result.reasonCode) {
		case "SOURCE_TOMBSTONED":
			return "source_tombstoned";
		case "QUOTE_MISMATCH":
		case "EVIDENCE_NOT_IN_INPUT":
		case "SOURCE_STALE":
			return "invalid_source";
		case "STALE_REVISION":
		case "REPLACES_MISMATCH":
			return "target_changed";
		default:
			return "conflict";
	}
}
