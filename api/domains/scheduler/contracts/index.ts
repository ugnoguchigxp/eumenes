import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";

export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
export const misfirePolicies = ["coalesce", "skip"] as const;
export const scheduleStates = [
	"active",
	"paused",
	"cancelled",
	"completed",
] as const;

const offsetTime = z.iso.datetime({ offset: true });
export const createScheduleSchema = z.object({
	requestId: z.uuid(),
	target: z.object({
		kind: z.string().min(1).max(80),
		payload: z.unknown(),
	}),
	schedule: z.discriminatedUnion("type", [
		z.object({ type: z.literal("once"), at: offsetTime }),
		z.object({
			type: z.literal("interval"),
			anchor: offsetTime,
			intervalMs: z.number().int().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS),
		}),
	]),
	misfirePolicy: z.enum(misfirePolicies).default("coalesce"),
	graceMs: z.number().int().min(0).max(86_400_000).default(300_000),
});
export type CreateSchedule = z.infer<typeof createScheduleSchema>;

export const scheduleOperationSchema = z.object({
	expectedRevision: z.number().int().min(0),
});

export const scheduleSchema = z.object({
	id: z.string(),
	requestId: z.string(),
	scope: z.string(),
	targetKind: z.string(),
	targetVersion: z.number().int(),
	targetPayload: z.unknown(),
	state: z.enum(scheduleStates),
	revision: z.number().int(),
	mode: z.enum(["once", "interval"]),
	anchorAt: z.string(),
	intervalMs: z.number().int().nullable(),
	nextDueAt: z.string(),
	misfirePolicy: z.enum(misfirePolicies),
	graceMs: z.number().int(),
	overlapPolicy: z.literal("skip"),
	deferReason: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type ScheduleDto = z.infer<typeof scheduleSchema>;

export const scheduleListSchema = z.object({
	items: z.array(scheduleSchema),
	nextCursor: z.string().nullable(),
});

export const occurrenceSchema = z.object({
	id: z.string(),
	scheduleId: z.string(),
	scheduleRevision: z.number().int(),
	scheduledAt: z.string(),
	state: z.enum(["dispatched", "skipped"]),
	jobId: z.string().nullable(),
	subjectRef: z.string().nullable(),
	/** Current state of the dispatched Queue job; dispatching is not completion. */
	jobState: z.string().nullable(),
	reason: z.string().nullable(),
	createdAt: z.string(),
});
export type OccurrenceDto = z.infer<typeof occurrenceSchema>;
export const occurrenceListSchema = z.object({
	items: z.array(occurrenceSchema),
	nextCursor: z.string().nullable(),
});

/** HTTP status of each error code this domain throws; merged by `api/application/error-status.ts`. */
export const errorStatus = {
	schedule_state_conflict: 409,
	schedule_limit_reached: 503,
} as const satisfies Record<string, HttpErrorStatus>;
