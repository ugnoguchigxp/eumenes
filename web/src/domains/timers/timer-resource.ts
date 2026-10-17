import type { Resource } from "@eumenes/artifact-ui/contracts";
import type { z } from "zod";
import type { timerGetResponseSchema } from "../../../../api/domains/timers/contracts";
import { displayRemainingSeconds, estimatedServerNow } from "./clock";

export type TimerView = z.infer<typeof timerGetResponseSchema> & {
	/** Local instant the request was sent (for deadline wake-ups). */
	sentAt: number;
	clock: { baseServer: number; baseMono: number };
};

export const setupResource: Resource = {
	kind: "timer-workspace",
	revision: 0,
	state: "setup",
};

function durationLabel(seconds: number) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	return `${hours ? `${hours}時間` : ""}${minutes ? `${minutes}分` : ""}${remainder ? `${remainder}秒` : ""}`;
}

function finishLabel(dueAt: string, serverNow: string) {
	const due = new Date(dueAt);
	const today = due.toDateString() === new Date(serverNow).toDateString();
	return new Intl.DateTimeFormat("ja-JP", {
		...(today ? {} : { month: "short", day: "numeric" }),
		hour: "numeric",
		minute: "2-digit",
	}).format(due);
}

/**
 * The saved timer as the clock resource. The remaining time is derived from the server clock
 * bound to the last answer; a timer still active at zero is "confirming" until the server says
 * otherwise (the browser never decides it elapsed).
 */
export function timerResource(
	view: TimerView,
	monoNow: number,
	canCreate: boolean,
): Resource {
	const { timer } = view;
	const seconds = displayRemainingSeconds(
		{
			dueAt: timer.dueAt,
			serverNow: view.serverNow,
			state: timer.state,
			cancelledAt: timer.cancelledAt,
			pausedAt: timer.pausedAt,
			remainingSeconds: timer.remainingSeconds,
		},
		estimatedServerNow(view.clock, Math.max(monoNow, view.clock.baseMono)),
	);
	const confirming = timer.state === "active" && seconds === 0;
	const duration = durationLabel(timer.durationSeconds);
	return {
		kind: "timer-workspace",
		revision: timer.revision,
		state: confirming ? "confirming" : timer.state,
		title: timer.label === "タイマー" ? `${duration}のタイマー` : timer.label,
		durationSeconds: timer.durationSeconds,
		remainingSeconds: seconds,
		durationLabel: duration,
		dueAt:
			timer.state === "cancelled" || timer.state === "paused"
				? undefined
				: timer.dueAt,
		finishLabel: finishLabel(timer.dueAt, view.serverNow),
		canCreate,
	};
}
