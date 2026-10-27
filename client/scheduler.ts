import {
	type CreateSchedule,
	occurrenceListSchema,
	scheduleListSchema,
	scheduleSchema,
} from "../api/domains/scheduler/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";

type CreateInput = Omit<CreateSchedule, "misfirePolicy" | "graceMs"> &
	Partial<Pick<CreateSchedule, "misfirePolicy" | "graceMs">>;

export function schedulerClient(transport: Transport) {
	const path = (id: string) => `/api/schedules/${encodeURIComponent(id)}`;
	const operate = (id: string, op: string, expectedRevision: number) =>
		callJson(
			transport,
			scheduleSchema,
			`${path(id)}/${op}`,
			json({ expectedRevision }),
		);
	return {
		createSchedule: async (input: CreateInput) =>
			callJson(transport, scheduleSchema, "/api/schedules", json(input)),
		schedules: async (
			query: { state?: string; cursor?: string; limit?: number } = {},
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				scheduleListSchema,
				withQuery("/api/schedules", query),
				{ signal },
			),
		schedule: async (id: string, signal?: AbortSignal) =>
			callJson(transport, scheduleSchema, path(id), { signal }),
		scheduleOccurrences: async (
			id: string,
			query: { cursor?: string; limit?: number } = {},
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				occurrenceListSchema,
				withQuery(`${path(id)}/occurrences`, query),
				{ signal },
			),
		pauseSchedule: (id: string, expectedRevision: number) =>
			operate(id, "pause", expectedRevision),
		resumeSchedule: (id: string, expectedRevision: number) =>
			operate(id, "resume", expectedRevision),
		/** Stops future occurrences only; already queued runs must be cancelled separately. */
		cancelSchedule: (id: string, expectedRevision: number) =>
			operate(id, "cancel", expectedRevision),
	};
}
