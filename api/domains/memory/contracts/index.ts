import { z } from "zod";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../conversation/contracts";
import { continuityItemSchema } from "../../continuity/contracts";
import type { VectorSpaceShape } from "../../../infrastructure/vector";
/** Earlier exchanges sent verbatim; older ones reach the model only through memory (prefetch). */
export const TURN_WINDOW = 10;
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
const datePartSchema = z.object({
	precision: z.enum(["year", "month", "day"]),
	year: z.number().int(),
	month: z.number().int().optional(),
	day: z.number().int().optional(),
});
export const rememberSchema = z.object({
	conversationId: z.string().min(1),
	/** The user message the fact comes from. */
	messageId: z.string().min(1),
	/** An exact substring of that message. */
	quote: z.string().min(1).max(1024),
	kind: z.enum(stateKinds),
	semanticKey: z.string().min(1).max(128),
	text: z.string().trim().min(1).max(500),
	polarity: z.enum(["affirmed", "negated"]).default("affirmed"),
	/** Optional validity (ms since epoch). `validUntilMs` is exclusive. */
	validFromMs: z.number().int().nonnegative().optional(),
	validUntilMs: z.number().int().nonnegative().optional(),
	/** Calendar period with precision ("since September" stays month precision). Not combinable with the ms bounds. */
	validity: z
		.object({
			from: datePartSchema.optional(),
			until: datePartSchema.optional(),
			basis: z.enum(["stated", "inferred", "unknown"]),
		})
		.optional(),
});
export type Remember = z.infer<typeof rememberSchema>;
export const itemActionSchema = z.object({
	expectedRevision: z.number().int().min(1),
});
export const settingsSchema = z.object({ enabled: z.boolean() });
/** Who asked for an item: the user in conversation, the memory agent on its own, or the API. */
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
	/** Ordinal of the oldest message in the verbatim window: the per-turn recall looks only before it (0: no window yet). */
	windowStartOrdinal: number;
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
export const forgetResultSchema = z.object({
	forgetId: z.string(),
	completed: z.boolean(),
});

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
export const okSchema = z.object({ ok: z.literal(true) });
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
