import {
	timerClaimResponseSchema,
	timerGetResponseSchema,
	timerListResponseSchema,
	timerNotificationListSchema,
	timerReceiptSchema,
	timerRunReceiptSchema,
	type CancelTimerInput,
	type StartTimerInput,
} from "../api/domains/timers/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";

export function timersClient(transport: Transport) {
	const act = (id: string, action: string, input: CancelTimerInput) =>
		callJson(
			transport,
			timerReceiptSchema,
			`/api/timers/${encodeURIComponent(id)}/${action}`,
			json(input),
		);
	return {
		startTimer: async (input: StartTimerInput) =>
			callJson(transport, timerReceiptSchema, "/api/timers", json(input)),
		timers: async (
			query: {
				state?: string;
				conversationId?: string;
				timerId?: string;
				cursor?: string;
				limit?: number;
			} = {},
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				timerListResponseSchema,
				withQuery("/api/timers", query),
				{ signal },
			),
		timer: async (id: string, signal?: AbortSignal) =>
			callJson(
				transport,
				timerGetResponseSchema,
				`/api/timers/${encodeURIComponent(id)}`,
				{ signal },
			),
		timerReceiptByRun: async (runId: string, signal?: AbortSignal) =>
			callJson(
				transport,
				timerRunReceiptSchema,
				`/api/timer-actions/by-run/${encodeURIComponent(runId)}`,
				{ signal },
			),
		cancelTimer: async (id: string, input: CancelTimerInput) =>
			act(id, "cancel", input),
		timerNotifications: async (
			query: { cursor?: string; limit?: number } = {},
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				timerNotificationListSchema,
				withQuery("/api/timer-notifications", query),
				{ signal },
			),
		archiveTimerNotifications: async () => {
			await transport.call("/api/timer-notifications/archive", {
				method: "POST",
			});
		},
		claimTimerNotification: async (
			id: string,
			input: {
				clientId: string;
				claimRequestId: string;
				expectedRevision: number;
			},
		) =>
			callJson(
				transport,
				timerClaimResponseSchema,
				`/api/timer-notifications/${encodeURIComponent(id)}/claim`,
				json(input),
			),
		ackTimerNotification: async (
			id: string,
			input: {
				clientId: string;
				claimId: string;
				outcome: "played" | "muted" | "blocked";
			},
		) =>
			callJson(
				transport,
				timerClaimResponseSchema,
				`/api/timer-notifications/${encodeURIComponent(id)}/ack`,
				json(input),
			),
		silenceTimerNotification: async (
			id: string,
			input: { expectedRevision: number; reason: "muted" | "blocked" },
		) =>
			callJson(
				transport,
				timerClaimResponseSchema,
				`/api/timer-notifications/${encodeURIComponent(id)}/silence`,
				json(input),
			),
	};
}
