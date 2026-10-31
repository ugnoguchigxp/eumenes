import { getLogger } from "../../../infrastructure/logger";
import {
	LARM_CAPACITY_TIMEOUT,
	planCapacityWait,
	type CapacityWait,
} from "../contracts/capacity";

/**
 * Settles a request LARM refused for lack of free memory: plans the next try, keeps the owning run open
 * for it where allowed, then schedules the try or ends the wait. The record, its job and the wording
 * stay with the owning domain; this is the one place the rule and its logs are decided.
 */
export function settleCapacityWait(input: {
	/** The owning domain: the log component and the event prefix. */
	domain: string;
	subjectId: string;
	now: number;
	previous: Pick<CapacityWait, "startedAt" | "count"> | null | undefined;
	retryAfterMs: number | null;
	/** How long the request may take once LARM accepts it. */
	budgetMs: number;
	/** A deadline the caller fixed (a delegated task's budget); the wait never passes it. */
	limitAt?: number | null;
	/** Extends the owning run to `deadline`; returns the run's deadline afterwards, or null when it ended. */
	extend?: (deadline: number) => number | null;
	/** Ends the request with `larm_capacity_timeout`. */
	expire: () => void;
	/** Marks the record as waiting and enqueues the next try; returns the new job's id. */
	schedule: (plan: CapacityWait) => string | undefined;
}): CapacityWait | null {
	const log = getLogger(input.domain);
	const waitedMs = input.now - (input.previous?.startedAt ?? input.now);
	const plan = planCapacityWait(input);
	if (
		!plan ||
		(input.extend && (input.extend(plan.deadline) ?? 0) < plan.deadline)
	) {
		log.warn(`${input.domain}.capacity_wait_expired`, {
			subjectId: input.subjectId,
			reason: LARM_CAPACITY_TIMEOUT,
			waitedMs,
		});
		input.expire();
		return null;
	}
	log.info(`${input.domain}.capacity_wait_scheduled`, {
		jobId: input.schedule(plan),
		subjectId: input.subjectId,
		waitCount: plan.count,
		waitedMs,
		nextInMs: plan.at - input.now,
	});
	return plan;
}
