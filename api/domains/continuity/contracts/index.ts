import { z } from "zod";
/** Open items per conversation: keeps the recalled context inside its fixed byte budget. */
export const MAX_ACTIVE_CONTINUITY = 30;
export const continuityKinds = [
	"goal",
	"decision",
	"open_question",
	"activity",
	"memo",
] as const;
export type ContinuityKind = (typeof continuityKinds)[number];
/** How long an item stays in the short-term layer when nothing else is said; kinds not listed never expire. */
export const CONTINUITY_TTL_MS: Partial<Record<ContinuityKind, number>> = {
	activity: 14 * 24 * 60 * 60 * 1000,
	memo: 7 * 24 * 60 * 60 * 1000,
};
export const continuityStatuses = ["active", "resolved", "retracted"] as const;
export const continuityItemSchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	kind: z.enum(continuityKinds),
	text: z.string().min(1).max(500),
	status: z.enum(continuityStatuses),
	revision: z.number().int(),
	createdAt: z.string(),
	updatedAt: z.string(),
	/** Written by the user, or by the memory agent from the conversation. */
	origin: z.enum(["user", "agent"]),
	/** The messages an agent-written item comes from (forgetting any of them deletes the item). */
	sourceMessageIds: z.array(z.string()),
	/** After this time the item is no longer part of the context (its status stays). */
	expiresAt: z.string().nullable(),
});
export type ContinuityItem = z.infer<typeof continuityItemSchema>;
/** Goals, decisions, open questions, recent activity and memos that must survive restarts and topic changes. */
export interface ContinuitySnapshot {
	/** Changes whenever any item of the conversation changes. */
	revision: number;
	/** Active items that have not expired. */
	items: ContinuityItem[];
}
