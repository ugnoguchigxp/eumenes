import { z } from "zod";

/** A finished TODO as its notice on screen tells it (the TODO completion notice design, section 3). */
export const todoNoticeSchema = z.strictObject({
	/** The TODO's id. */
	id: z.string(),
	conversationId: z.string(),
	title: z.string(),
	/** The toolchain the work went to, as registered now; absent when it is gone. */
	toolchainTitle: z.string().optional(),
	outcome: z.enum(["succeeded", "partial", "failed", "interrupted"]),
	/** The result in one line (resources by name, never their URIs); null when there is none. */
	summary: z.string().nullable(),
	/** The registered screen of the toolchain the work went to (`timers.workspace`); absent when it has none. */
	artifactId: z.string().optional(),
	/** What the work made, in the order it named them. */
	links: z.array(
		z.strictObject({ uri: z.string(), label: z.string(), kind: z.string() }),
	),
	read: z.boolean(),
	/** When the TODO finished (was archived). */
	createdAt: z.string(),
});
export type TodoNotice = z.infer<typeof todoNoticeSchema>;

export const todoNoticesSchema = z.strictObject({
	notices: z.array(todoNoticeSchema),
	/** Unread notices in all, not only the listed page. */
	unread: z.number().int().nonnegative(),
});
export type TodoNotices = z.infer<typeof todoNoticesSchema>;

export const todoNoticesQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
});
