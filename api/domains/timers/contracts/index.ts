import { z } from "zod";

export const timerStates = ["active", "elapsed", "cancelled"] as const;
export type TimerState = (typeof timerStates)[number];
export const notificationStatuses = [
	"pending",
	"claimed",
	"played",
	"silent",
	"dismissed",
] as const;
export type NotificationStatus = (typeof notificationStatuses)[number];
export const notificationReasons = ["muted", "blocked", "stale"] as const;
export type NotificationReason = (typeof notificationReasons)[number];

const offsetTime = z.iso.datetime({ offset: true });
const labelSchema = z.string().trim().min(1).max(80);

export const startTimerSchema = z
	.object({
		requestId: z.uuid(),
		issuedAt: offsetTime,
		durationSeconds: z.number().int().min(1).max(86400),
		label: labelSchema.optional(),
	})
	.strict();
export type StartTimerInput = z.infer<typeof startTimerSchema>;

export const cancelTimerSchema = z
	.object({
		requestId: z.uuid(),
		issuedAt: offsetTime,
		expectedRevision: z.number().int().min(0),
	})
	.strict();
export type CancelTimerInput = z.infer<typeof cancelTimerSchema>;

export const listTimersQuerySchema = z
	.object({
		state: z.enum(timerStates).optional(),
		conversationId: z.string().min(1).max(128).optional(),
		timerId: z.uuid().optional(),
		cursor: z.string().min(1).max(512).optional(),
		limit: z.number().int().min(1).max(100).optional(),
	})
	.strict();
export type ListTimersQuery = z.infer<typeof listTimersQuerySchema>;

export const timerCommandSchema = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("start"),
			durationSeconds: z.number().int().min(1).max(86400),
			label: labelSchema.optional(),
		})
		.strict(),
	z
		.object({
			operation: z.literal("list"),
			timerId: z.uuid().optional(),
			state: z.enum(timerStates).optional(),
		})
		.strict(),
	z
		.object({
			operation: z.literal("cancel"),
			timerId: z.uuid(),
			expectedRevision: z.number().int().min(0),
		})
		.strict(),
]);
export type TimerCommand = z.infer<typeof timerCommandSchema>;

export const claimNotificationSchema = z
	.object({
		clientId: z.uuid(),
		claimRequestId: z.uuid(),
		expectedRevision: z.number().int().min(0),
	})
	.strict();
export type ClaimNotificationInput = z.infer<typeof claimNotificationSchema>;

export const ackNotificationSchema = z
	.object({
		clientId: z.uuid(),
		claimId: z.uuid(),
		outcome: z.enum(["played", "muted", "blocked"]),
	})
	.strict();
export type AckNotificationInput = z.infer<typeof ackNotificationSchema>;

export const silenceNotificationSchema = z
	.object({
		expectedRevision: z.number().int().min(0),
		reason: z.enum(["muted", "blocked"]),
	})
	.strict();
export type SilenceNotificationInput = z.infer<
	typeof silenceNotificationSchema
>;

export type TimerDto = {
	id: string;
	revision: number;
	state: TimerState;
	label: string;
	durationSeconds: number;
	startedAt: string;
	dueAt: string;
	cancelledAt: string | null;
	remainingSeconds: number;
	conversationId: string | null;
	originRunId: string | null;
	originMessageId: string | null;
	errorCode: string | null;
	bodyExpired: boolean;
};

export type TimerArtifactRefV1 = { kind: "timer"; version: 1; timerId: string };

export type TimerNotificationDto = {
	id: string;
	timerId: string;
	generation: number;
	revision: number;
	status: NotificationStatus;
	reason: NotificationReason | null;
	dueAt: string;
	message: string;
};

export type TimerCompletion = {
	notificationId: string;
	timerId: string;
	conversationId: string | null;
	message: string;
	at: string;
};

export type TimerReceipt =
	| {
			kind: "timer_action";
			action: "started";
			operationId: string;
			serverNow: string;
			timer: TimerDto;
			artifact: TimerArtifactRefV1;
	  }
	| {
			kind: "timer_action";
			action: "listed";
			operationId: string;
			serverNow: string;
			items: TimerDto[];
			nextCursor: string | null;
	  }
	| {
			kind: "timer_action";
			action: "cancelled" | "dismissed" | "unchanged";
			operationId: string;
			serverNow: string;
			timer: TimerDto;
	  };

export type TimerOrigin = {
	scope: string;
	conversationId: string | null;
	runId: string | null;
	messageId: string | null;
	originKey: string | null;
};

const timerDtoSchema = z
	.object({
		id: z.uuid(),
		revision: z.number().int(),
		state: z.enum(timerStates),
		label: z.string(),
		durationSeconds: z.number().int(),
		startedAt: offsetTime,
		dueAt: offsetTime,
		cancelledAt: offsetTime.nullable(),
		remainingSeconds: z.number().int().min(0),
		conversationId: z.string().nullable(),
		originRunId: z.string().nullable(),
		originMessageId: z.string().nullable(),
		errorCode: z.string().nullable(),
		bodyExpired: z.boolean(),
	})
	.strict();

const artifactSchema = z
	.object({
		kind: z.literal("timer"),
		version: z.literal(1),
		timerId: z.uuid(),
	})
	.strict();

export const timerNotificationDtoSchema = z
	.object({
		id: z.uuid(),
		timerId: z.uuid(),
		generation: z.number().int(),
		revision: z.number().int(),
		status: z.enum(notificationStatuses),
		reason: z.enum(notificationReasons).nullable(),
		dueAt: offsetTime,
		message: z.string(),
	})
	.strict();

export const timerReceiptSchema = z.discriminatedUnion("action", [
	z
		.object({
			kind: z.literal("timer_action"),
			action: z.literal("started"),
			operationId: z.uuid(),
			serverNow: offsetTime,
			timer: timerDtoSchema,
			artifact: artifactSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("timer_action"),
			action: z.literal("listed"),
			operationId: z.uuid(),
			serverNow: offsetTime,
			items: z.array(timerDtoSchema),
			nextCursor: z.string().nullable(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("timer_action"),
			action: z.enum(["cancelled", "dismissed", "unchanged"]),
			operationId: z.uuid(),
			serverNow: offsetTime,
			timer: timerDtoSchema,
		})
		.strict(),
]);

export const timerListResponseSchema = z
	.object({
		serverNow: offsetTime,
		items: z.array(timerDtoSchema),
		nextCursor: z.string().nullable(),
	})
	.strict();

export const timerGetResponseSchema = z
	.object({
		serverNow: offsetTime,
		timer: timerDtoSchema,
		notification: timerNotificationDtoSchema.nullable(),
	})
	.strict();

export const timerRunReceiptSchema = z
	.object({
		serverNow: offsetTime,
		receipt: timerReceiptSchema.nullable(),
	})
	.strict();

export const timerNotificationListSchema = z
	.object({
		serverNow: offsetTime,
		activeTimers: z.number().int().min(0).default(0),
		items: z.array(timerNotificationDtoSchema),
		nextCursor: z.string().nullable(),
	})
	.strict();

export const timerClaimResponseSchema = z
	.object({
		serverNow: offsetTime,
		notification: timerNotificationDtoSchema,
		claimId: z.uuid().optional(),
		leaseUntil: offsetTime.optional(),
	})
	.strict();

export const DEFAULT_TIMER_SCOPE = "default";
export const DEFAULT_TIMER_LABEL = "タイマー";
export const TIMER_EXPIRE_KIND = "timer.expire";
