import { z } from "zod";
import {
	monitoringSnapshotSchema,
	monitoringEventsSchema,
	monitoringEventSchema,
} from "../../larm/contracts";

export const larmReadStatusSchema = z.object({
	status: z.enum([
		"not_requested",
		"unconfigured",
		"ok",
		"unreachable",
		"timeout",
		"unauthorized",
		"forbidden",
		"not_found",
		"unsupported_contract",
		"rate_limited",
		"unavailable",
		"invalid_response",
		"http_error",
		"catching_up",
		"epoch_mismatch",
	]),
	at: z.number(),
	httpStatus: z.number().int().optional(),
	code: z.string().optional(),
	reasonCode: z.string().optional(),
	retryAfterMs: z.number().nonnegative().optional(),
});
export type LarmReadStatus = z.infer<typeof larmReadStatusSchema>;
const pageSchema = monitoringEventsSchema.omit({ events: true });
const gapSchema = z.object({
	at: z.number(),
	reason: z.enum([
		"monitoring_cursor_expired",
		"monitoring_epoch_changed",
		"epoch_mismatch",
		"stream_gap",
		"coverage_gap",
	]),
	bootEpoch: z.string().optional(),
	detail: z.string().optional(),
});
export const collectedLarmSchema = z.object({
	snapshot: monitoringSnapshotSchema.optional(),
	snapshotReceivedAt: z.number().optional(),
	snapshotRequestedAt: z.number().optional(),
	snapshotStatus: larmReadStatusSchema,
	eventsStatus: larmReadStatusSchema,
	page: pageSchema.optional(),
	cursor: z.string().nullable(),
	bootEpoch: z.string().optional(),
	nextPollAt: z.number(),
	gaps: z.array(gapSchema),
	gapCount: z.string().default("0"),
	localPrunedBefore: z.number().optional(),
});
export type CollectedLarm = z.infer<typeof collectedLarmSchema>;
export const larmViewSchema = collectedLarmSchema
	.omit({ cursor: true, page: true })
	.extend({
		history: z.object({
			eventStream: monitoringEventsSchema.shape.eventStream.optional(),
			coverage: monitoringEventsSchema.shape.coverage.optional(),
			window: monitoringEventsSchema.shape.window.optional(),
			hasMore: z.boolean(),
			coverageComplete: z.boolean(),
			events: z.array(monitoringEventSchema).max(200),
			faults: z.array(monitoringEventSchema),
			results: z.object({
				succeeded: z.string(),
				failed: z.string(),
				timed_out: z.string(),
				cancelled: z.string(),
				rejected: z.string(),
			}),
		}),
	});
export type LarmView = z.infer<typeof larmViewSchema>;
export const emptyLarm = (now: number): CollectedLarm => ({
	snapshotStatus: { status: "not_requested", at: now },
	eventsStatus: { status: "not_requested", at: now },
	cursor: null,
	nextPollAt: 0,
	gaps: [],
	gapCount: "0",
});
