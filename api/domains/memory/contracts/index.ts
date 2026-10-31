import { z } from "zod";
import type { ContinuityKind } from "../../continuity/contracts";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../conversation/contracts";
import type { VectorSpaceShape } from "../../../infrastructure/vector";
/** The owner principal; defined once in conversation (the lower domain). */
export const PRINCIPAL = CONVERSATION_DEFAULT_PRINCIPAL;
/** The shared profile scope. Per-conversation continuity is composed into it for the active conversation. */
export const PROFILE_SCOPE = "profile:owner";
import { stateKinds } from "./state-kinds";
import type { HttpErrorStatus } from "../../../infrastructure/http";
export { stateKinds } from "./state-kinds";
export {
	memorySeedResultSchema,
	parseMemorySeedJsonl,
	type MemorySeed,
} from "./seeds";
export const settingsSchema = z.object({ enabled: z.boolean() });
/** Who asked for an item: the user in conversation (`request`), or the steward on its own (`agent`). `manual`: rows from before manual changes were removed. */
type MemoryCapturedBy = "request" | "agent" | "manual";
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
	evidence: {
		messageId: string | null;
		quote: string | null;
		/** Candidate provenance is separate from conversation messages. */
		source?: { namespace: string; kind: string; id: string; label: string };
	}[];
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
	/** The messages the prompt shows verbatim: a forget of one of them expires the run. */
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
/** The messages of the exchanges a search found (each exchange's user input and adopted answer). */
export type TurnRecall = {
	pins: { messageId: string; digest: string }[];
};
export type SettleResult =
	| { ok: true }
	| { ok: false; reason: "memory_stale" | "memory_unavailable" };

export const memoryStatusSchema: z.ZodType<MemoryStatus> = z.object({
	enabled: z.boolean(),
	healthy: z.boolean(),
});
const memoryItemSchema: z.ZodType<MemoryItemDto> = z.object({
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
		z.object({
			messageId: z.string().nullable(),
			quote: z.string().nullable(),
			source: z
				.object({
					namespace: z.string(),
					kind: z.string(),
					id: z.string(),
					label: z.string(),
				})
				.optional(),
		}),
	),
	validity: z
		.object({ from: z.string().optional(), until: z.string().optional() })
		.nullable(),
	capturedBy: z.enum(["request", "agent", "manual"]),
});
export const memoryItemsSchema = z.object({ items: z.array(memoryItemSchema) });

export type MemoryTendencyDto = {
	id: string;
	text: string;
	revision: number;
	updatedAt: string;
};
/** The long-term part of the ContextWindow as the screen shows it: the published profile and what waits beside it. */
export type MemoryContextDto =
	| { disabled: true }
	| {
			disabled?: undefined;
			version: number;
			/** The published profile as the conversation reads it (JSON) and its estimated size (tokens). */
			profile: { text: string; tokens: number };
			/** Current items the published profile does not show yet. */
			newMemories: number;
	  };

// ---- the block ledger ----

export type { BlockReason } from "../repository/ledger";

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
	derived?: ForgetDerived;
};
/**
 * Ids of data other domains derived and delete themselves (for example `{ goalIds }`), keyed by a name the registered
 * purge hook understands. Memory never interprets it: it is written to the block journal line before the database,
 * handed to every purge hook, and handed again when the line is replayed at startup.
 */
export type ForgetDerived = Readonly<Record<string, readonly string[]>>;
export type ForgetOutcome = {
	forgetId: string;
	/** Every message that was blocked (the item evidence, the steward's choices and their run partners). */
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
	/** The opaque `derived` of the forget that wrote this journal line (empty when it had none). */
	derived: ForgetDerived;
};
/** HTTP status of each code the memory operations throw. */
export const errorStatus = {
	memory_unavailable: 409,
	memory_forget_incomplete: 409,
} as const satisfies Record<string, HttpErrorStatus>;
