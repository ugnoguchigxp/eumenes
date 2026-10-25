import { z } from "zod";
import { ref } from "./ref";
const bytes = (n: number) =>
	z
		.string()
		.trim()
		.min(1)
		.refine(
			(v) => new TextEncoder().encode(v).length <= n,
			"invalid_dots_message_size",
		);
export const messageText = bytes(32768);
export const messagingSettingInput = z.strictObject({
	expectedRevision: z.number().int().min(0),
	enabled: z.boolean(),
});
export const messageConversationInput = z.strictObject({
	requestId: z.uuid(),
	connectionRef: ref,
	conversationId: ref,
});
export const sendMessageInput = z.strictObject({
	requestId: z.uuid(),
	text: messageText,
});
export const cancelMessageInput = z.strictObject({
	requestId: z.uuid(),
	expectedRevision: z.number().int().positive(),
});
export const messageReplyInput = z
	.strictObject({
		replyId: z.uuid(),
		commandId: ref,
		messageId: ref,
		leaseId: z.uuid(),
		epoch: z.number().int().positive(),
		outcome: z.enum(["answered", "failed"]),
		replyText: messageText,
		summary: bytes(4096).nullable(),
		coveredMessageIds: z.array(ref).max(20),
		limitations: z.array(bytes(1024)).max(8),
	})
	.refine(
		(v) => v.outcome !== "answered" || v.summary !== null,
		"invalid_dots_summary",
	)
	.refine(
		(v) => new TextEncoder().encode(JSON.stringify(v)).length <= 49152,
		"invalid_dots_message_size",
	);
export type MessageReply = z.infer<typeof messageReplyInput>;
export type MessagingSetting = {
	connectionRef: string;
	enabled: boolean;
	revision: number;
	epoch: number;
	verifiedAt: number | null;
};
export type MessageConversation = {
	id: string;
	requestId: string;
	connectionRef: string;
	conversationId: string;
	epoch: number;
	revision: number;
	sequence: number;
	createdAt: number;
};
export type OutgoingMessage = {
	id: string;
	requestId: string;
	threadId: string;
	connectionRef: string;
	sequence: number;
	userMessageId: string;
	commandId: string;
	epoch: number;
	settingsEpoch: number;
	connectionRevision: number;
	expiresAt: number;
	createdAt: number;
	terminalAt: number | null;
	state:
		| "pending"
		| "claimed"
		| "answered"
		| "failed"
		| "cancelled"
		| "expired";
	revision: number;
	replyId: string | null;
	bodyBytes: number;
	redacted: boolean;
};
export type MessageReceipt = {
	replyId: string;
	messageId: string;
	state: "answered" | "failed";
	replyMessageId: string;
	summaryMessageId: string | null;
};
export type SavedMessageReply = {
	id: string;
	messageId: string;
	threadId: string;
	connectionRef: string;
	digest: string;
	receipt: MessageReceipt;
	coveredMessageIds: string[];
	limitations: string[];
	basedOnReplyId: string | null;
	createdAt: number;
	redacted: boolean;
};
export type MessageCommand = {
	commandId: string;
	taskId?: never;
	messageId: string;
	messageConversationId: string;
	connectionRef: string;
	kind: "message";
	authorityEpoch: number;
	executionGeneration: number;
	createdAt: number;
	expiresAt: number;
	state: "pending" | "claimed" | "reported" | "superseded";
	leaseId: string | null;
	snapshot: Record<string, unknown>;
};
export const messagingSettingSchema = z.object({
	connectionRef: z.string(),
	enabled: z.boolean(),
	revision: z.number(),
	epoch: z.number(),
	verifiedAt: z.number().nullable(),
});
export const messageConversationSchema = z.object({
	id: z.string(),
	requestId: z.string(),
	connectionRef: z.string(),
	conversationId: z.string(),
	epoch: z.number(),
	revision: z.number(),
	sequence: z.number(),
	createdAt: z.number(),
});
export const outgoingMessageSchema = z.object({
	id: z.string(),
	commandId: z.string(),
	threadId: z.string(),
	sequence: z.number(),
	revision: z.number(),
	state: z.enum([
		"pending",
		"claimed",
		"answered",
		"failed",
		"cancelled",
		"expired",
	]),
	expiresAt: z.number(),
	redacted: z.boolean(),
});
export const messagingViewSchema = z.object({
	thread: messageConversationSchema,
	setting: messagingSettingSchema,
	subscription: z.object({
		subscribed: z.boolean(),
		expiresAt: z.number().nullable(),
	}),
	items: z.array(
		outgoingMessageSchema.extend({
			delivery: z
				.object({ state: z.string(), httpStatus: z.number().nullable() })
				.nullable(),
			text: z.string().nullable(),
			reply: z
				.object({
					id: z.string(),
					replyText: z.string().nullable(),
					summary: z.string().nullable(),
					limitations: z.array(z.string()),
				})
				.nullable(),
		}),
	),
	nextCursor: z.number().nullable(),
});
export type MessagingView = z.infer<typeof messagingViewSchema>;
