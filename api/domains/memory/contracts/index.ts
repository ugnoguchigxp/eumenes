import { z } from "zod";
import type { ContinuityKind } from "../../continuity/contracts";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../conversation/contracts";
import { continuityItemSchema } from "../../continuity/contracts";
import type { VectorSpaceShape } from "../../../infrastructure/vector";
/** Without a ContextWindow (memory off) the newest runs sent verbatim; older ones are not sent. */
export const TURN_WINDOW = 10;
/** The verbatim exchanges (L3, unprocessed, the newest two) stay inside this size, whatever their length. */
export const HISTORY_MAX_BYTES = 48 * 1024;
/** One message of the history is cut to this size: head and tail stay, the middle is marked as left out. */
export const HISTORY_MESSAGE_MAX_BYTES = 12 * 1024;
/** The owner principal; defined once in conversation (the lower domain). */
export const PRINCIPAL = CONVERSATION_DEFAULT_PRINCIPAL;
/** The shared profile scope. Per-conversation continuity is composed into it for the active conversation. */
export const PROFILE_SCOPE = "profile:owner";
export const stateKinds = [
	"preference",
	"personal_fact",
	"constraint",
	"habit",
] as const;
export const settingsSchema = z.object({ enabled: z.boolean() });
/** Who asked for an item: the user in conversation (`request`), or the steward on its own (`agent`). `manual`: rows from before manual changes were removed. */
export type MemoryCapturedBy = "request" | "agent" | "manual";
export interface MemoryItemDto {
	id: string;
	kind: string;
	semanticKey: string;
	text: string;
	polarity: "affirmed" | "negated";
	status: string;
	origin: string;
	revision: number;
	sourceMessageIds: string[];
	validFromMs: number | null;
	validUntilMs: number | null;
	/** The words the item stands on; `quote` is null when the message or the range is no longer readable. */
	evidence: { messageId: string; quote: string | null }[];
	/** Calendar period as `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; null when the item has none. */
	validity: { from?: string; until?: string } | null;
	capturedBy: MemoryCapturedBy;
}
export type MemoryStatus = {
	enabled: boolean;
	/** false while the forget journal is inconsistent: memory is not used at all. */
	healthy: boolean;
};
/**
 * What a run fixes of its ContextWindow at prepare time; re-checked in the adoption transaction.
 * The texts stay in the prompt: this only carries the versions and ids needed to judge staleness.
 */
export type PreparedWindow = {
	conversationId: string;
	version: number;
	buildId: string;
	immediateSeq: number;
	policyRevision: string;
	/** Item ids the prompt stood on: the long-term layer and the recently remembered (usage receipt). */
	manifest: string[];
	/** Earlier messages the prefetched text stands on: a changed digest expires the run. */
	pins: { messageId: string; digest: string }[];
	noticeIds: string[];
	/** Bytes of the prefetched text already in the prompt (the per-turn recall fills what is left of its budget). */
	prefetchBytes: number;
	/** The messages the prompt shows verbatim: the per-turn recall leaves them out. */
	shownMessageIds: string[];
};
/** The vector space of an embedding (same shape as the toolchain embeddings'). */
export type MemoryVectorSpace = VectorSpaceShape;
/**
 * The embedding function memory is given (the application binds it to the saved LARM connection;
 * memory imports neither the application nor capabilities).
 */
export type MemoryEmbed = (
	texts: string[],
	type: "query" | "passage",
	signal: AbortSignal,
) => Promise<{ vectors: number[][]; space: MemoryVectorSpace }>;
/** Earlier exchanges found by meaning, as a reference block, and the messages it stands on. */
export type TurnRecall = {
	text: string;
	pins: { messageId: string; digest: string }[];
	bytes: number;
};
export type SettleResult =
	| { ok: true }
	| { ok: false; reason: "memory_stale" | "memory_unavailable" };

export const memoryStatusSchema: z.ZodType<MemoryStatus> = z.object({
	enabled: z.boolean(),
	healthy: z.boolean(),
});
export const memoryItemSchema: z.ZodType<MemoryItemDto> = z.object({
	id: z.string(),
	kind: z.string(),
	semanticKey: z.string(),
	text: z.string(),
	polarity: z.enum(["affirmed", "negated"]),
	status: z.string(),
	origin: z.string(),
	revision: z.number(),
	sourceMessageIds: z.array(z.string()),
	validFromMs: z.number().nullable(),
	validUntilMs: z.number().nullable(),
	evidence: z.array(
		z.object({ messageId: z.string(), quote: z.string().nullable() }),
	),
	validity: z
		.object({ from: z.string().optional(), until: z.string().optional() })
		.nullable(),
	capturedBy: z.enum(["request", "agent", "manual"]),
});
export const memoryItemsSchema = z.object({ items: z.array(memoryItemSchema) });

/** Query of the short-term and context APIs: the conversation is always named (there is no default). */
export const conversationQuerySchema = z.object({
	conversationId: z.string().min(1).max(120),
});
export const shortTermSchema = z.object({
	items: z.array(continuityItemSchema),
});
export type MemoryTendencyDto = {
	id: string;
	text: string;
	revision: number;
	updatedAt: string;
};
export const memoryTendenciesSchema: z.ZodType<{
	items: MemoryTendencyDto[];
}> = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			text: z.string(),
			revision: z.number(),
			updatedAt: z.string(),
		}),
	),
});
/** The ContextWindow as the screen shows it: sizes against their limits, and the rendered texts. */
export type MemoryContextDto =
	| { disabled: true }
	| {
			disabled?: undefined;
			version: number;
			longTerm: { text: string; bytes: number; limit: number };
			shortTerm: {
				text: string;
				bytes: number;
				limit: number;
				pendingAdditions: number;
			};
			/** How many notices wait for the next turn. */
			notices: number;
	  };
export const memoryContextSchema: z.ZodType<MemoryContextDto> = z.union([
	z.object({ disabled: z.literal(true) }),
	z.object({
		version: z.number(),
		longTerm: z.object({
			text: z.string(),
			bytes: z.number(),
			limit: z.number(),
		}),
		shortTerm: z.object({
			text: z.string(),
			bytes: z.number(),
			limit: z.number(),
			pendingAdditions: z.number(),
		}),
		notices: z.number(),
	}),
]);

// ---- the steward's ledgers (exchanges, summary, blocked messages) ----

export type {
	BlockReason,
	Disposition,
	ExchangeRow as ExchangeDto,
	ExchangeStep,
	StepMark,
	SummaryRow as SummaryDto,
} from "../repository/ledger";

/** What a run left to learn from: the user's message and, when one was adopted, the answer. */
export type RecordExchangeInput = {
	conversationId: string;
	runId: string;
	inputMessageId: string;
	answerMessageId: string | null;
	outcome: "answered" | "failed";
};

// ---- the save contract ----

/** A calendar bound as the model writes it: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
type CurationDate = string;
/**
 * One element of a curation, already resolved by the steward (labels to ids and revisions). The host builds the
 * evidence from `messageId` (a user message of the conversation) and `quote` (only a hint).
 */
export type CurationItem =
	| {
			op: "remember";
			kind: (typeof stateKinds)[number];
			/** The model's `key`; normalized to the item's `semanticKey`, an invalid one rejects the element. */
			key: string;
			text: string;
			negated?: boolean;
			messageId: string;
			quote?: string | null;
			validFrom?: CurationDate | null;
			validUntil?: CurationDate | null;
			/** The user asked for it (K14): always a new version, origin `user_confirmed`, even when the value is the same. */
			explicit?: boolean;
	  }
	| {
			op: "update";
			itemId: string;
			revision: number;
			text: string;
			negated?: boolean;
			messageId: string;
			quote?: string | null;
			validFrom?: CurationDate | null;
			validUntil?: CurationDate | null;
			explicit?: boolean;
	  }
	| { op: "stop"; itemId: string; revision: number }
	| {
			op: "merge";
			sources: ReadonlyArray<{ itemId: string; revision: number }>;
			/** Defaults to the key of the newest source. */
			key?: string | null;
			text: string;
			negated?: boolean;
	  }
	| {
			op: "note_add";
			kind: ContinuityKind;
			text: string;
			/** The messages the note comes from (at least one, all of the conversation, none blocked). */
			messageIds: string[];
	  }
	| {
			op: "note_update";
			noteId: string;
			revision: number;
			text: string;
			/** Messages added to the note's sources (the union; none are removed). */
			messageIds?: string[];
	  }
	| {
			op: "note_close";
			noteId: string;
			revision: number;
			status: "resolved" | "retracted";
	  }
	| {
			op: "tendency_add";
			text: string;
			evidence: ReadonlyArray<{
				namespace: "state" | "continuity";
				id: string;
			}>;
	  }
	| {
			op: "tendency_update";
			tendencyId: string;
			revision: number;
			text: string;
			evidence: ReadonlyArray<{
				namespace: "state" | "continuity";
				id: string;
			}>;
	  }
	| { op: "tendency_retire"; tendencyId: string; revision: number };
export type CurationRejection =
	| "invalid_key"
	| "invalid_input"
	| "invalid_validity"
	| "invalid_source"
	| "blocked_source"
	| "source_tombstoned"
	| "no_evidence"
	| "unknown_item"
	| "item_changed"
	| "limit_reached"
	| "conflict";
export type CurationResult =
	| {
			status: "applied";
			op: CurationItem["op"];
			/** The State item, note or tendency written (remember, update, merge, a note, a tendency) or stopped (stop). */
			id: string | null;
			revision: number | null;
			/** false: the same value was already stored (nothing new was written). */
			changed: boolean;
			/** remember/update: whether the model's quote was found in the message (false: the whole message is the evidence). */
			quoteMatched: boolean | null;
			/** An explicit `remember` that saved an already stored value again. */
			reconfirmed: boolean;
			/** merge: the sources that were stopped (the one it replaced is superseded, not listed). */
			stoppedIds: string[];
	  }
	| { status: "rejected"; op: CurationItem["op"]; reason: CurationRejection };

/** One forget call accepts at most this many explicit `itemIds` (before the expansion by versions, merge lineage and evidence). More throws `forget_limit`. */
export const FORGET_MAX_ITEMS = 5;
/** The steward's forget request: State items (every version goes), messages it also found, and the conversation they came up in. */
export type ForgetInput = {
	conversationId: string;
	itemIds: readonly string[];
	messageIds: readonly string[];
};
export type ForgetOutcome = {
	forgetId: string;
	/** Every message that was blocked (the item evidence, the steward's choices and their exchange partners). */
	blockedMessageIds: string[];
	/** Every State item id that was forgotten (all versions). */
	forgottenItemIds: string[];
	completed: boolean;
};
/** What a derived-data purge is told (the steward registers one: decisions, inbox bodies). */
export type ForgetPurge = {
	itemIds: readonly string[];
	messageIds: readonly string[];
	conversationId: string;
	/** The conversations whose summary this forget (or this replay of it) deleted: their summary-step decisions go too. */
	deletedSummaryConversationIds: readonly string[];
};
