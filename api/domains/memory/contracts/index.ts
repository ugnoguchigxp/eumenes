import { z } from "zod";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../conversation/contracts";
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
}
export type MemoryStatus = {
	enabled: boolean;
	/** false while the forget journal is inconsistent: memory is not used at all. */
	healthy: boolean;
};
export type PrepareResult =
	| { status: "disabled" }
	| { status: "blocked"; reason: "overflow" | "blocked" }
	| { status: "ready"; view: unknown; block: string; itemIds: string[] };
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
});
export const memoryItemsSchema = z.object({ items: z.array(memoryItemSchema) });
export const forgetResultSchema = z.object({
	forgetId: z.string(),
	completed: z.boolean(),
});
