import {
	attemptSchema,
	jobListSchema,
	jobSchema,
	queueStatusSchema,
} from "../api/domains/queue/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";

export function queueClient(transport: Transport) {
	const get = async (path: string, signal?: AbortSignal) =>
		(await transport.call(path, { signal })).json();
	return {
		queueStatus: async (signal?: AbortSignal) =>
			queueStatusSchema.parse(await get("/api/queue/status", signal)),
		jobs: async (
			query: {
				state?: string;
				kind?: string;
				cursor?: string;
				limit?: number;
			} = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(query))
				if (v !== undefined) params.set(k, String(v));
			return jobListSchema.parse(await get(`/api/jobs?${params}`, signal));
		},
		job: async (id: string, signal?: AbortSignal) =>
			jobSchema.parse(await get(`/api/jobs/${encodeURIComponent(id)}`, signal)),
		jobAttempts: async (id: string, signal?: AbortSignal) =>
			attemptSchema
				.array()
				.parse(
					await get(`/api/jobs/${encodeURIComponent(id)}/attempts`, signal),
				),
		cancelJob: async (id: string, reason?: string) =>
			jobSchema.parse(
				await (
					await transport.call(
						`/api/jobs/${encodeURIComponent(id)}/cancel`,
						json({ reason }),
					)
				).json(),
			),
	};
}
export type QueueClient = ReturnType<typeof queueClient>;
