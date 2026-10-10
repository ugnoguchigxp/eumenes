import { z } from "zod";
const ref = z.string().uuid();
export const historySearchInput = z
	.object({
		query: z.string().trim().max(200).default(""),
		from: z.string().datetime({ offset: true }).optional(),
		until: z.string().datetime({ offset: true }).optional(),
		speaker: z.enum(["user", "assistant"]).optional(),
		cursor: ref.optional(),
		limit: z.number().int().min(1).max(20).default(10),
	})
	.strict()
	.refine(
		(v) => !v.from || !v.until || Date.parse(v.from) < Date.parse(v.until),
	);
export const historyReadInput = z
	.object({
		messageRef: ref,
		before: z.number().int().min(0).max(9).default(2),
		after: z.number().int().min(0).max(9).default(2),
		cursor: ref.optional(),
	})
	.strict()
	.refine((v) => v.before + v.after < 10);
export const historyViewSchema = z.object({
	kind: z.literal("conversation_source"),
	messageRef: ref,
	messageId: z.string(),
	conversationId: z.string(),
	speaker: z.enum(["user", "assistant"]),
	createdAt: z.string(),
	revision: z.string(),
	digest: z.string(),
	viewId: ref,
	viewDigest: z.string(),
	start: z.number().int().nonnegative(),
	end: z.number().int().nonnegative(),
	text: z.string(),
	truncated: z.boolean(),
	nextCursor: ref.nullable(),
});
export const historyScopeSchema = z.object({
	conversationId: z.string(),
	conversationRevision: z.number(),
	scopeRef: ref,
	scannedMessages: z.number(),
	scannedBytes: z.number(),
	scanComplete: z.boolean(),
	expiresAt: z.string(),
});
export const historySearchResultSchema = z.object({
	candidates: z.array(historyViewSchema).max(20),
	cursor: ref.nullable(),
	scope: historyScopeSchema,
});
export const historyReadResultSchema = z.object({
	messages: z.array(historyViewSchema).max(10),
	scope: historyScopeSchema,
});
export type HistorySearchInput = z.input<typeof historySearchInput>;
export type HistoryReadInput = z.input<typeof historyReadInput>;
export type HistoryView = z.infer<typeof historyViewSchema>;
export type HistoryScope = z.infer<typeof historyScopeSchema>;
/** Host only. Agent and authenticated API scopes never exchange references. */
export type HistoryOwner = {
	key: string;
	conversationId: string;
	deadline: number;
	excludeMessageId?: string;
};
