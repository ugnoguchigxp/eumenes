import {
	timerResultContext,
	type TimerResultContext,
} from "../domains/capabilities/contracts/timers";
import type { TimerReceipt } from "../domains/timers/contracts";
export function projectTimerResult(receipt: TimerReceipt): TimerResultContext {
	const timers = receipt.action === "listed" ? receipt.items : [receipt.timer];
	return timerResultContext.parse({
		version: 1,
		kind: "timer_action",
		action: receipt.action,
		observedAt: receipt.serverNow,
		items: timers.map(
			({
				id,
				revision,
				label,
				state,
				durationSeconds,
				remainingSeconds,
				dueAt,
			}) => ({
				id,
				revision,
				label,
				state,
				durationSeconds,
				remainingSeconds,
				dueAt,
			}),
		),
		complete: receipt.action !== "listed" || receipt.nextCursor === null,
		errorCode: null,
	});
}
