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
import type { Transport } from "./transport";
import { json } from "./transport";

export function timersClient(transport: Transport) {
	return {
		startTimer: async (input: StartTimerInput) =>
			timerReceiptSchema.parse(
				await (await transport.call("/api/timers", json(input))).json(),
			),
		timers: async (
			query: {
				state?: string;
				conversationId?: string;
				timerId?: string;
				cursor?: string;
				limit?: number;
			} = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(query))
				if (value !== undefined) params.set(key, String(value));
			return timerListResponseSchema.parse(
				await (
					await transport.call(`/api/timers?${params}`, { signal })
				).json(),
			);
		},
		timer: async (id: string, signal?: AbortSignal) =>
			timerGetResponseSchema.parse(
				await (
					await transport.call(`/api/timers/${encodeURIComponent(id)}`, {
						signal,
					})
				).json(),
			),
		timerReceiptByRun: async (runId: string, signal?: AbortSignal) =>
			timerRunReceiptSchema.parse(
				await (
					await transport.call(
						`/api/timer-actions/by-run/${encodeURIComponent(runId)}`,
						{ signal },
					)
				).json(),
			),
		cancelTimer: async (id: string, input: CancelTimerInput) =>
			timerReceiptSchema.parse(
				await (
					await transport.call(
						`/api/timers/${encodeURIComponent(id)}/cancel`,
						json(input),
					)
				).json(),
			),
		timerNotifications: async (
			query: { cursor?: string; limit?: number } = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(query))
				if (value !== undefined) params.set(key, String(value));
			return timerNotificationListSchema.parse(
				await (
					await transport.call(`/api/timer-notifications?${params}`, { signal })
				).json(),
			);
		},
		claimTimerNotification: async (
			id: string,
			input: {
				clientId: string;
				claimRequestId: string;
				expectedRevision: number;
			},
		) =>
			timerClaimResponseSchema.parse(
				await (
					await transport.call(
						`/api/timer-notifications/${encodeURIComponent(id)}/claim`,
						json(input),
					)
				).json(),
			),
		ackTimerNotification: async (
			id: string,
			input: {
				clientId: string;
				claimId: string;
				outcome: "played" | "muted" | "blocked";
			},
		) =>
			timerClaimResponseSchema.parse(
				await (
					await transport.call(
						`/api/timer-notifications/${encodeURIComponent(id)}/ack`,
						json(input),
					)
				).json(),
			),
		silenceTimerNotification: async (
			id: string,
			input: { expectedRevision: number; reason: "muted" | "blocked" },
		) =>
			timerClaimResponseSchema.parse(
				await (
					await transport.call(
						`/api/timer-notifications/${encodeURIComponent(id)}/silence`,
						json(input),
					)
				).json(),
			),
	};
}
