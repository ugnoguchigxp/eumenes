import { z } from "zod";
import { avatarMotionSchema, speechDeliverySchema } from "../../delivery";
export const messageSchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	role: z.enum(["user", "assistant"]),
	text: z.string(),
	createdAt: z.string(),
	runId: z.string().nullable(),
	avatarMotion: avatarMotionSchema.optional(),
	delivery: speechDeliverySchema.optional(),
});
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
	id: z.string(),
	revision: z.number().int(),
	messages: z.array(messageSchema),
});
export type Conversation = z.infer<typeof conversationSchema>;

/** Source identity used by the conversation outbox and the World SourceAdapter. */
export const CONVERSATION_SOURCE_NAMESPACE = "conversation";
export const CONVERSATION_SOURCE_KIND = "message";
export const CONVERSATION_SOURCE_REPRESENTATION = "text";
/**
 * Default principal / scope of conversation sources. These deliberately duplicate
 * memory's PRINCIPAL / PROFILE_SCOPE (conversation must not depend on memory); the
 * world domain tests assert they stay equal. The host may inject other values.
 */
export const CONVERSATION_DEFAULT_PRINCIPAL = "local:owner";
export const CONVERSATION_DEFAULT_SCOPE = "profile:owner";

export type OutboxKind = "added" | "corrected" | "retracted";
/**
 * One ordinary-change event. It never carries message text. `seq` is strictly
 * increasing but gaps are allowed. For `retracted` the revision is the literal
 * `retracted` and the digest is empty (there is no content any more). Once a
 * source is retracted all its earlier events are rewritten to the same
 * revision/digest, and a correction rewrites the superseded events of that source
 * to revision `superseded` with an empty digest: only the newest event of a live
 * message carries a real revision/digest. seq/kind/ids never change, so cursors
 * stay valid.
 */
export type OutboxEvent = {
	seq: number;
	kind: OutboxKind;
	namespace: string;
	sourceKind: string;
	sourceId: string;
	representation: string;
	revision: string;
	digest: string;
	principal: string;
	scopeKey: string;
	conversationId: string;
	speaker: "user" | "assistant";
	occurredAt: string;
};

/** `sha256:<hex of text>`: the revision scheme memory's messageSource uses too. */
export type TextRevision = { revision: string; digest: string };

export type ConversationSourceState =
	| {
			state: "available";
			message: Message;
			/**
			 * SQLite rowid of the message. Only comparable between currently
			 * available messages (larger = accepted later). It is not a stable
			 * identity: rowids are not guaranteed to be contiguous and may be reused
			 * if rows are ever physically deleted (retraction tombstones in place, so
			 * it does not free one today). Never persist it as an id or cursor.
			 */
			ordinal: number;
			revision: string;
			digest: string;
			principal: string;
			scopeKey: string;
			/** Only confirmed messages are ever stored; drafts never reach this table. */
			confirmed: true;
	  }
	| { state: "retracted"; principal: string; scopeKey: string; seq: number }
	| { state: "missing" };

export type ChangeResult =
	| {
			status: "applied";
			kind: "corrected" | "retracted";
			seq: number;
			revision: string;
			conversationRevision: number;
	  }
	/** Replay of an already applied correction/retraction: nothing is written. */
	| { status: "unchanged" }
	| { status: "not_found" }
	/** The message was retracted earlier and can no longer be corrected. */
	| { status: "retracted" };
