import { z } from "zod";

export const BOOKMARK_TEXT_MAX = 2000;
export const ACTIVE_BOOKMARK_MAX = 50;
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 100;

const idSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9._:-]+$/);
/** Conversation ids are owned by the conversation domain: any non-empty string. */
export const conversationIdSchema = z
	.string()
	.min(1)
	.max(120)
	.refine((id) => id !== "." && id !== "..");
export const bookmarkKindSchema = z.enum(["goal", "decision", "open_question"]);
export const bookmarkStatusSchema = z.enum(["active", "inactive"]);
export const bookmarkOperationSchema = z.enum([
	"create",
	"revise",
	"deactivate",
]);
export const bookmarkOriginSchema = z.enum(["user_confirmed", "user_edited"]);
export const bookmarkTextSchema = z
	.string()
	.trim()
	.min(1)
	.max(BOOKMARK_TEXT_MAX);
const revisionSchema = z.number().int().min(1);

export const createBookmarkRequestSchema = z.object({
	requestId: idSchema,
	sourceMessageId: idSchema,
	kind: bookmarkKindSchema,
	text: bookmarkTextSchema,
});
export const reviseBookmarkRequestSchema = z.object({
	requestId: idSchema,
	expectedRevision: revisionSchema,
	kind: bookmarkKindSchema,
	text: bookmarkTextSchema,
});
export const deactivateBookmarkRequestSchema = z.object({
	requestId: idSchema,
	expectedRevision: revisionSchema,
});
export type CreateBookmarkRequest = z.infer<typeof createBookmarkRequestSchema>;
export type ReviseBookmarkRequest = z.infer<typeof reviseBookmarkRequestSchema>;
export type DeactivateBookmarkRequest = z.infer<
	typeof deactivateBookmarkRequestSchema
>;

/** Current value of a bookmark (derived from its latest event). */
export const bookmarkSchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	kind: bookmarkKindSchema,
	text: z.string(),
	status: bookmarkStatusSchema,
	revision: z.number().int(),
	origin: bookmarkOriginSchema,
	sourceMessageId: z.string(),
	sourceDigest: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type Bookmark = z.infer<typeof bookmarkSchema>;

export const bookmarkEventSchema = z.object({
	sequence: z.number().int(),
	id: z.string(),
	bookmarkId: z.string(),
	conversationId: z.string(),
	operation: bookmarkOperationSchema,
	kind: bookmarkKindSchema,
	text: z.string(),
	status: bookmarkStatusSchema,
	revision: z.number().int(),
	sourceMessageId: z.string(),
	sourceDigest: z.string(),
	origin: bookmarkOriginSchema,
	requestId: z.string(),
	createdAt: z.string(),
});
export type BookmarkEvent = z.infer<typeof bookmarkEventSchema>;

export const bookmarkListSchema = z.object({
	conversationId: z.string(),
	stateRevision: z.number().int(),
	bookmarks: z.array(bookmarkSchema),
});
export type BookmarkList = z.infer<typeof bookmarkListSchema>;

export const bookmarkHistorySchema = z.object({
	bookmarkId: z.string(),
	events: z.array(bookmarkEventSchema),
	/** Pass as `after` to fetch the next page; null when exhausted. */
	nextCursor: z.number().int().nullable(),
});
export type BookmarkHistory = z.infer<typeof bookmarkHistorySchema>;

export const sourceStatusSchema = z.enum(["ok", "missing", "changed"]);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;
export const bookmarkSourceSchema = z.object({
	bookmarkId: z.string(),
	sourceMessageId: z.string(),
	sourceDigest: z.string(),
	status: sourceStatusSchema,
	message: z
		.object({
			id: z.string(),
			role: z.enum(["user", "assistant"]),
			text: z.string(),
			createdAt: z.string(),
		})
		.nullable(),
});
export type BookmarkSource = z.infer<typeof bookmarkSourceSchema>;

/** Consistent read snapshot: only ACTIVE bookmarks, each with its source check. */
export const continuitySnapshotSchema = z.object({
	conversationId: z.string(),
	stateRevision: z.number().int(),
	items: z.array(
		z.object({ bookmark: bookmarkSchema, sourceStatus: sourceStatusSchema }),
	),
});
export type ContinuitySnapshot = z.infer<typeof continuitySnapshotSchema>;

export type ContinuityProjection =
	| {
			status: "ready";
			conversationId: string;
			stateRevision: number;
			instructionAuthority: "none";
			items: Array<{
				bookmarkId: string;
				kind: Bookmark["kind"];
				text: string;
				origin: Bookmark["origin"];
				source: { messageId: string; digest: string };
			}>;
	  }
	| {
			status: "overflow" | "blocked";
			conversationId: string;
			stateRevision: number;
			instructionAuthority: "none";
			reason: string;
	  };

export type ContinuityErrorCode =
	| "invalid_request"
	| "bookmark_limit_exceeded"
	| "not_found"
	| "request_conflict"
	| "revision_conflict"
	| "bookmark_inactive";
const statusByCode: Record<ContinuityErrorCode, 400 | 404 | 409> = {
	invalid_request: 400,
	bookmark_limit_exceeded: 400,
	not_found: 404,
	request_conflict: 409,
	revision_conflict: 409,
	bookmark_inactive: 409,
};
export class ContinuityError extends Error {
	readonly status: 400 | 404 | 409;
	constructor(
		readonly code: ContinuityErrorCode,
		detail?: string,
	) {
		super(detail ? `${code}:${detail}` : code);
		this.status = statusByCode[code];
	}
}
