import type { Database } from "bun:sqlite";
import type { TasksService, WorkTask } from "../../tasks";
import type { TaskReports, ReportBody } from "../../task-reports";
import type { Supervisor } from "../contracts";

export function evidence(s: Supervisor) {
	return [
		...new Set([
			...[s.checks, s.review, s.commit, s.push].flatMap((r) =>
				r?.evidenceRefs[0] ? [r.evidenceRefs[0]] : [],
			),
			...(s.observation?.evidenceRefs ?? []),
			...[s.checks, s.review, s.commit, s.push].flatMap(
				(r) => r?.evidenceRefs ?? [],
			),
		]),
	].slice(0, 20);
}
export function createReporting(input: {
	reports: TaskReports;
	tasks: () => TasksService;
	now: () => number;
}) {
	const { reports, tasks, now } = input;
	return function report(
		db: Database,
		t: WorkTask,
		s: Supervisor,
		kind: ReportBody["kind"],
		summary: string,
		key: string,
		code?: string,
	) {
		return reports.appendInTransaction(
			db,
			t.id,
			`${t.executionGeneration}:${t.authorityEpoch}:${key}`,
			{
				kind,
				summary,
				facts: (kind === "cancelled" || kind === "paused"
					? [`確認済みのタスク状態: ${t.state}`]
					: (s.observation?.facts ?? [])
				)
					.slice(0, 6)
					.map((f) => f.slice(0, 300)),
				limitations: [
					...new Set([
						...(code ? [code] : s.holdReason ? [s.holdReason] : []),
						// Fixed codes for what is still unknown; details stay in the private observation.
						...(s.observation?.details?.limitations ?? []),
						// Not checked, failed and passed are different facts, never one "failure".
						...(!s.checks
							? ["verification_not_checked"]
							: !s.checks.checks?.results.every((r) => r.passed)
								? ["verification_failed"]
								: []),
					]),
				].slice(0, 8),
				git:
					s.commit || s.push
						? {
								commitSha: s.commit?.commit?.sha ?? null,
								remoteSha: s.push?.push?.sha ?? null,
								branch:
									s.commit?.commit?.branch ?? s.push?.push?.branch ?? null,
								remote: s.push?.push?.remote ?? null,
							}
						: null,
				evidenceRefs: evidence(s),
				snapshotHash: s.observation?.snapshotHash ?? null,
				questionId:
					kind === "blocker"
						? (tasks().openQuestionInTransaction(db, t.id)?.id ?? null)
						: null,
			},
			s.lastObservedAt ?? now(),
		);
	};
}
