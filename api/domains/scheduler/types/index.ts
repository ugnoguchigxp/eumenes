import type { z } from "zod";
import type { Tx } from "../../queue";

interface TargetOccurrence<P> {
	scheduleId: string;
	occurrenceId: string;
	scheduledAtMs: number;
	payload: P;
}

/**
 * A registered, typed target. The owning domain implements it; the scheduler
 * never runs arbitrary code. `materializeInTransaction` runs inside the same
 * Writer transaction that records the occurrence, so business state, Queue job
 * and occurrence commit together or not at all.
 */
export interface TargetDefinition<P> {
	kind: string;
	version: number;
	publicCreate?: false;
	schema: z.ZodType<P>;
	validateInTransaction?(tx: Tx, payload: P): void;
	/** A safe reason code keeps this occurrence due until the target can accept it. */
	deferReasonInTransaction?(
		tx: Tx,
		occurrence: Omit<TargetOccurrence<P>, "occurrenceId">,
	): string | null;
	materializeInTransaction(
		tx: Tx,
		occurrence: TargetOccurrence<P>,
	): { jobId: string; subjectRef: string | null };
}

export interface SchedulerOptions {
	now?: () => number;
	id?: () => string;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	pollMs?: number;
	tickLimit?: number;
	maxSchedules?: number;
	capacityBackoffMs?: number;
}
