import {
	attemptSchema,
	jobListSchema,
	jobSchema,
	queueStatusSchema,
} from "../api/domains/queue/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";

export function queueClient(transport: Transport) {
	return {
		queueStatus: async (signal?: AbortSignal) =>
			callJson(transport, queueStatusSchema, "/api/queue/status", { signal }),
		jobs: async (
			query: {
				state?: string;
				kind?: string;
				cursor?: string;
				limit?: number;
			} = {},
			signal?: AbortSignal,
		) =>
			callJson(transport, jobListSchema, withQuery("/api/jobs", query), {
				signal,
			}),
		job: async (id: string, signal?: AbortSignal) =>
			callJson(transport, jobSchema, `/api/jobs/${encodeURIComponent(id)}`, {
				signal,
			}),
		jobAttempts: async (id: string, signal?: AbortSignal) =>
			callJson(
				transport,
				attemptSchema.array(),
				`/api/jobs/${encodeURIComponent(id)}/attempts`,
				{ signal },
			),
		cancelJob: async (id: string, reason?: string) =>
			callJson(
				transport,
				jobSchema,
				`/api/jobs/${encodeURIComponent(id)}/cancel`,
				json({ reason }),
			),
	};
}
