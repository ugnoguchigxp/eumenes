import {
	type CreateSchedule,
	occurrenceListSchema,
	scheduleListSchema,
	scheduleSchema,
} from "../api/domains/scheduler/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";

type CreateInput = Omit<CreateSchedule, "misfirePolicy" | "graceMs"> &
	Partial<Pick<CreateSchedule, "misfirePolicy" | "graceMs">>;

export function schedulerClient(transport: Transport) {
	const path = (id: string) => `/api/schedules/${encodeURIComponent(id)}`;
	const operate = async (id: string, op: string, expectedRevision: number) =>
		scheduleSchema.parse(
			await (
				await transport.call(`${path(id)}/${op}`, json({ expectedRevision }))
			).json(),
		);
	return {
		createSchedule: async (input: CreateInput) =>
			scheduleSchema.parse(
				await (await transport.call("/api/schedules", json(input))).json(),
			),
		schedules: async (
			query: { state?: string; cursor?: string; limit?: number } = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(query))
				if (v !== undefined) params.set(k, String(v));
			return scheduleListSchema.parse(
				await (
					await transport.call(`/api/schedules?${params}`, { signal })
				).json(),
			);
		},
		schedule: async (id: string, signal?: AbortSignal) =>
			scheduleSchema.parse(
				await (await transport.call(path(id), { signal })).json(),
			),
		scheduleOccurrences: async (
			id: string,
			query: { cursor?: string; limit?: number } = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(query))
				if (v !== undefined) params.set(k, String(v));
			return occurrenceListSchema.parse(
				await (
					await transport.call(`${path(id)}/occurrences?${params}`, { signal })
				).json(),
			);
		},
		pauseSchedule: (id: string, expectedRevision: number) =>
			operate(id, "pause", expectedRevision),
		resumeSchedule: (id: string, expectedRevision: number) =>
			operate(id, "resume", expectedRevision),
		/** Stops future occurrences only; already queued runs must be cancelled separately. */
		cancelSchedule: (id: string, expectedRevision: number) =>
			operate(id, "cancel", expectedRevision),
	};
}
export type SchedulerClient = ReturnType<typeof schedulerClient>;
