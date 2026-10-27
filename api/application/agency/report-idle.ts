import { createIdlePlanner, type IdlePlanner } from "eumenes-agency";

/** Share the existing idle lifecycle; completed work has no unanswered-social-remark allowance to spend. */
export function createReportIdlePlanner(
	config: Parameters<typeof createIdlePlanner>[0],
	at: number,
	hasReports: () => boolean,
) {
	const social = createIdlePlanner(config, at);
	const reports = createIdlePlanner({ ...config, maxUnanswered: 1 }, at);
	const selected = () => (hasReports() ? reports : social);
	const both = (call: (planner: IdlePlanner) => void) => {
		call(social);
		call(reports);
	};
	return {
		userTurn: (now: number) => both((p) => p.userTurn(now)),
		enter: () => both((p) => p.enter()),
		leave: (now: number) => both((p) => p.leave(now)),
		setPaused: (value: boolean, now: number) =>
			both((p) => p.setPaused(value, now)),
		stop: () => both((p) => p.stop()),
		proactiveSpoke: (now: number) => social.proactiveSpoke(now),
		reportSpoke: (now: number) => reports.userTurn(now),
		idleSilent: (now: number) => selected().idleSilent(now),
		blockedBy: () => selected().blockedBy(),
		delayMs: (now: number) => selected().delayMs(now),
		status: () => selected().status(),
		/** Once social talk is blocked, only a cited completed-work report may use this opportunity. */
		reportsOnly: () => hasReports() && social.blockedBy() !== null,
	};
}
export type ReportIdlePlanner = ReturnType<typeof createReportIdlePlanner>;
