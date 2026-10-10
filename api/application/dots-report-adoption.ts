import type { Database } from "bun:sqlite";
import type { DotReport, Command, createInbox } from "../domains/dots";
import type {
	TasksService,
	OrchestrationWorkTask,
	WorkTask,
} from "../domains/tasks";
import type { TaskReports } from "../domains/task-reports";
import { assertDotsSessionAccess } from "./dots-session-access";
export type DotsReportPorts = {
	tasks: () => TasksService;
	reports: TaskReports;
	inbox: ReturnType<typeof createInbox>;
	current: (db: Database, owner: string, c: Command) => OrchestrationWorkTask;
};
const fence = (t: WorkTask) => ({
	taskId: t.id,
	expectedRevision: t.revision,
	authorityEpoch: t.authorityEpoch,
	executionGeneration: t.executionGeneration,
});
const receipt = (t: WorkTask) => ({
	taskId: t.id,
	state: t.state,
	revision: t.revision,
	authorityEpoch: t.authorityEpoch,
	executionGeneration: t.executionGeneration,
});
export function adoptDotsReport(
	db: Database,
	owner: string,
	r: DotReport,
	c: Command,
	ports: DotsReportPorts,
) {
	const { current, tasks, inbox, reports } = ports;
	const t = current(db, owner, c),
		known = inbox.sessionsInTransaction(db, t.id),
		project = c.snapshot.project as {
			nativeProjectId: string;
			hostId: string;
		};
	if (c.kind === "reminder" && (r.kind !== "reminder" || r.sessions.length))
		throw new Error("invalid_dots_report");
	if (c.kind === "stop" && r.kind !== "stopped") throw new Error("dots_stale");
	if (c.kind !== "stop" && r.kind === "stopped")
		throw new Error("invalid_dots_report");
	if (r.sessions.length)
		assertDotsSessionAccess(db, t, ports, r.sessions, c.kind === "stop");
	if (
		["completed", "failed", "cancelled", "paused"].includes(t.state) &&
		r.sessions.some((s) => !known.some((k) => k.threadId === s.threadId))
	)
		throw new Error("dots_stale");
	for (const s of r.sessions) {
		if (
			c.kind !== "stop" &&
			s.parentThreadId &&
			!known.some((k) => k.threadId === s.parentThreadId) &&
			!r.sessions.some((k) => k.threadId === s.parentThreadId) &&
			!t.grant.sessionRefs.includes(s.parentThreadId)
		)
			throw new Error("dots_permission_denied");
		if (s.projectId !== project.nativeProjectId || s.hostId !== project.hostId)
			throw new Error("dots_permission_denied");
		if (
			c.kind !== "stop" &&
			!known.some((k) => k.threadId === s.threadId) &&
			t.grant.sessionRefs.includes(s.threadId) &&
			!t.grant.operations.includes("continue_session")
		)
			throw new Error("dots_permission_denied");
		if (
			c.kind !== "stop" &&
			!known.some((k) => k.threadId === s.threadId) &&
			!t.grant.operations.includes("create_session") &&
			!t.grant.sessionRefs.includes(s.threadId)
		)
			throw new Error("dots_permission_denied");
	}
	if (
		c.kind !== "stop" &&
		new Set([...known, ...r.sessions].map((s) => s.threadId)).size >
			t.grant.maxSessions
	)
		throw new Error("dots_permission_denied");
	if (r.kind === "session_started" && !r.sessions.length)
		throw new Error("invalid_dots_report");
	if (
		["completed", "failed", "cancelled", "paused"].includes(t.state) &&
		!["no_next_work", "reminder"].includes(r.kind)
	)
		throw new Error("dots_stale");
	if (
		[
			"accepted",
			"session_started",
			"progress",
			"blocked",
			"completed",
		].includes(r.kind) &&
		["queued", "reconciling"].includes(t.state)
	)
		tasks().applyTransitionInTransaction(db, fence(t), {
			state: "active",
			reason: "dots_execution_acknowledged",
		});
	if (r.kind === "blocked") {
		if (!r.question) throw new Error("invalid_dots_report");
		tasks().askInTransaction(
			db,
			fence(tasks().getInTransaction(db, t.id)!),
			r.question,
		);
	}
	if (r.kind === "completed" || r.kind === "failed") {
		if (r.kind === "completed" && !known.length && !r.sessions.length)
			throw new Error("invalid_dots_report");
		const checks = r.completionChecks ?? [];
		if (
			r.kind === "completed" &&
			(checks.length !== t.completionConditions.length ||
				checks.some(
					(check) => check.status !== "satisfied" || !check.evidenceRefs.length,
				) ||
				!r.evidenceRefs.length)
		)
			throw new Error("invalid_dots_completion");
		tasks().applyTransitionInTransaction(
			db,
			fence(tasks().getInTransaction(db, t.id)!),
			{
				state: r.kind,
				reason: "dots_result_reported",
				result: {
					summary: r.summary,
					evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : [r.reportId],
					conditionsMet: checks.map((ch) => ch.status === "satisfied"),
				},
			},
		);
	}
	if (r.kind === "stopped") {
		if (
			r.childrenStopped !== true ||
			known.some((s) => !r.sessions.some((x) => x.threadId === s.threadId))
		)
			throw new Error("invalid_dots_stop");
		tasks().settleStopInTransaction(db, fence(t));
	}
	const latest = tasks().getInTransaction(db, t.id)!;
	if (!latest.bodyExpired) {
		const reportKind =
			r.kind === "blocked"
				? "blocker"
				: r.kind === "stopped"
					? latest.state === "paused"
						? "paused"
						: "cancelled"
					: ["completed", "failed", "no_next_work", "reminder"].includes(r.kind)
						? (r.kind as "completed" | "failed" | "no_next_work" | "reminder")
						: "progress";
		reports.appendInTransaction(db, t.id, r.reportId, {
			kind: reportKind,
			summary: r.summary,
			facts: r.facts,
			limitations: r.limitations,
			evidenceRefs: r.evidenceRefs,
			snapshotHash: null,
			questionId: r.question?.questionId ?? null,
		});
	}
	return {
		...receipt(latest),
		sourceSequence: r.sourceSequence,
		verification: "dots_reported" as const,
	};
}
