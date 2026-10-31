import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { Settings } from "../../settings";

export const liveStartSchema = z
	.object({
		requestId: z.uuid(),
		conversationId: z.string().min(1).max(120),
		test: z.boolean().optional(),
	})
	.strict();
export const liveStatusSchema = z.enum([
	"connecting",
	"active",
	"closing",
	"closed",
	"interrupted",
	"failed",
]);
export const liveSegmentSchema = z.object({
	id: z.string(),
	speaker: z.enum(["user", "assistant"]),
	text: z.string(),
	startMs: z.number(),
	endMs: z.number(),
	messageId: z.string().nullable(),
});
export const liveNoticeSchema = z.object({
	id: z.string(),
	text: z.string(),
	kind: z.enum(["announcement", "confirmation"]),
	displayed: z.boolean(),
});
export const liveSnapshotSchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	status: liveStatusSchema,
	muted: z.boolean(),
	test: z.boolean(),
	startedAt: z.string(),
	error: z.string().nullable(),
	usageConfirmed: z.boolean(),
	segments: z.array(liveSegmentSchema),
	notices: z.array(liveNoticeSchema),
});
export type LiveSnapshot = z.infer<typeof liveSnapshotSchema>;
export type LiveSegment = z.infer<typeof liveSegmentSchema>;
export type LiveNotice = z.infer<typeof liveNoticeSchema>;
export type LiveEvent =
	| { type: "state"; state: LiveSnapshot }
	| { type: "audio"; sequence: number; audio: string };
export type LiveSocket = Pick<
	WebSocket,
	| "send"
	| "close"
	| "addEventListener"
	| "removeEventListener"
	| "readyState"
	| "bufferedAmount"
>;
export type ConnectLive = (key: string) => LiveSocket;
/** Higher domains connect through these ports; Live never reads their tables. */
export type LiveConversationPort = {
	persona(general: Settings["general"]): { role: string; style: string };
	ensure(tx: Database, conversationId: string, at: string): void;
	history(
		tx: Database,
		conversationId: string,
	): Array<{ role: "user" | "assistant"; text: string }>;
	publish(
		tx: Database,
		input: {
			id: string;
			conversationId: string;
			role: "user" | "assistant";
			text: string;
			at: string;
		},
	): void;
	delegate(
		tx: Database,
		input: {
			requestId: string;
			conversationId: string;
			messageId: string;
			text: string;
			sessionId: string;
			inputVersion: number;
		},
	): { id: string };
	wake(): void;
	cancelReply(runId: string): Promise<{ status: string } | null>;
};

export const activeStatuses: readonly LiveSnapshot["status"][] = [
	"connecting",
	"active",
	"closing",
];
export const errorStatus = {
	live_permission_required: 403,
	live_permission_revoked: 403,
	live_credential_missing: 409,
	live_connection_invalid: 400,
	live_model_required: 400,
	live_invalid_input: 400,
	live_session_inactive: 409,
	live_conversation_busy: 409,
	live_stream_unavailable: 409,
	live_notice_missing: 404,
	live_audio_invalid: 400,
	live_audio_sequence: 409,
	live_input_changed: 409,
	live_legacy_voice_disabled: 409,
	live_model_catalog_failed: 502,
	live_storage_failed: 503,
	live_request_conflict: 409,
} as const;
