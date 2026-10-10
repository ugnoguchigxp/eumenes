import { useEffect, useRef } from "react";

const SETTLE_MS = 250;
const MAX_TIMEOUT_MS = 2_147_483_647;
/**
 * The server settles an expired timer a moment after its deadline. If the
 * first look still shows it active, look again a few times with growing gaps,
 * then leave the rest to the change stream.
 */
const OVERDUE_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

/**
 * Milliseconds from `now` until the earliest deadline that was still in the
 * future when the server answered, or null if none. Deadlines are compared
 * with the server clock, so a skewed browser clock does not matter.
 *
 * `fetchedAt` must be the local time the request was sent: the answer was made
 * no earlier, so a slow response or a busy page can only make the wake-up
 * early (the next look re-arms for the rest), never late.
 */
export function msUntilNextDeadline(
	dueAts: readonly string[],
	serverNow: string,
	fetchedAt: number,
	now = Date.now(),
): number | null {
	const base = Date.parse(serverNow);
	if (Number.isNaN(base)) return null;
	let earliest = Number.POSITIVE_INFINITY;
	for (const dueAt of dueAts) {
		const due = Date.parse(dueAt);
		// A deadline the server has already passed is not ours to wait for.
		if (due > base && due < earliest) earliest = due;
	}
	if (earliest === Number.POSITIVE_INFINITY) return null;
	return Math.max(0, earliest - base - (now - fetchedAt)) + SETTLE_MS;
}

/**
 * Calls `onDue` once when the earliest deadline passes. This replaces
 * polling: SSE reports every server-side change, and only the moment a timer
 * expires has no event of its own.
 */
export function useDeadline(
	dueAts: readonly string[],
	serverNow: string | undefined,
	fetchedAt: number,
	onDue: () => void,
) {
	const callback = useRef(onDue);
	useEffect(() => {
		callback.current = onDue;
	}, [onDue]);
	const overdue = useRef({ key: "", attempt: 0 });
	// Compare by value so a new array with the same deadlines keeps its timer.
	const key = dueAts.join("|");
	useEffect(() => {
		if (!serverNow || !key) {
			overdue.current = { key: "", attempt: 0 };
			return;
		}
		const retries = overdue.current;
		let delay = msUntilNextDeadline(key.split("|"), serverNow, fetchedAt);
		let retry = false;
		if (delay === null) {
			// Every deadline has passed on the server clock yet the timer is still listed.
			if (retries.key !== key) {
				retries.key = key;
				retries.attempt = 0;
			}
			delay = OVERDUE_RETRY_MS[retries.attempt] ?? null;
			retry = true;
		} else {
			retries.key = "";
			retries.attempt = 0;
		}
		if (delay === null) return;
		const timeout = setTimeout(
			() => {
				if (retry) retries.attempt++;
				callback.current();
			},
			Math.min(delay, MAX_TIMEOUT_MS),
		);
		return () => clearTimeout(timeout);
	}, [key, serverNow, fetchedAt]);
}
