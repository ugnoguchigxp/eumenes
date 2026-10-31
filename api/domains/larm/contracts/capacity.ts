/**
 * LARM's single "no free memory now" refusal (HTTP 503, `resource_exhausted`, resource `memory`).
 * It is returned before a request is accepted, so the same request may be sent again later.
 */
export const LARM_CAPACITY_REFUSAL = {
	status: 503,
	code: "resource_exhausted",
	resource: "memory",
} as const;
/** The error message a capacity refusal travels with; the owning domain turns it into a wait. */
export const LARM_CAPACITY_BUSY = "larm_capacity_busy";
/** The failure when the wait limit or a fixed deadline passes before LARM frees memory. */
export const LARM_CAPACITY_TIMEOUT = "larm_capacity_timeout";
/** The record phase / state shown while waiting for LARM memory. */
export const LARM_CAPACITY_WAITING = "waiting_capacity";
export const LARM_CAPACITY_RETRY_MS = 30_000;
export const LARM_CAPACITY_WAIT_LIMIT_MS = 30 * 60_000;
export const LARM_RETRY_AFTER_LIMIT_MS = 300_000;

export type CapacityWait = {
	/** When the first capacity refusal of this request arrived. */
	startedAt: number;
	/** How many tries have been scheduled after a capacity refusal. */
	count: number;
	/** When the next try is sent. */
	at: number;
	/** The deadline that gives the next try its whole processing budget. */
	deadline: number;
};

/** The delay before the next try: 30 s, or LARM's longer Retry-After up to 5 min. */
export const capacityRetryMs = (retryAfterMs: number | null) =>
	Math.min(
		Math.max(LARM_CAPACITY_RETRY_MS, retryAfterMs ?? 0),
		LARM_RETRY_AFTER_LIMIT_MS,
	);

/**
 * Schedules the next try after a capacity refusal, or `null` when it would pass the 30-minute wait
 * limit or `limitAt` (a deadline the caller fixed and the wait must not extend).
 */
export function planCapacityWait(input: {
	now: number;
	previous: Pick<CapacityWait, "startedAt" | "count"> | null | undefined;
	retryAfterMs: number | null;
	budgetMs: number;
	limitAt?: number | null;
}): CapacityWait | null {
	const startedAt = input.previous?.startedAt ?? input.now;
	const at = input.now + capacityRetryMs(input.retryAfterMs);
	if (at - startedAt > LARM_CAPACITY_WAIT_LIMIT_MS) return null;
	const deadline = at + input.budgetMs;
	if (input.limitAt != null && deadline > input.limitAt) return null;
	return { startedAt, count: (input.previous?.count ?? 0) + 1, at, deadline };
}
