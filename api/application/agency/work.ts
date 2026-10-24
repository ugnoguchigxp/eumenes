import type { Database } from "bun:sqlite";
import type { HostTodo } from "eumenes-agency";
import type {
	AgentRuntime,
	ExecutionWorkItem,
} from "../../domains/agent-runtime";
import type { DialogueService } from "../../domains/dialogue";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import { sendExecutionNotice } from "../toolchain/task-execution-port";

/** Characters of one TODO line (the agency prompt stays short). */
export const TODO_TITLE_CHARS = 60;
export const TODO_RESULT_CHARS = 120;

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const outcomeOf = (
	status: ExecutionWorkItem["status"],
): NonNullable<HostTodo["outcome"]> =>
	status === "completed"
		? "succeeded"
		: status === "partial"
			? "partial"
			: "failed";

/** A work item as the agency sees it: open → `todo`, finished with its report held → `done`. */
export function hostTodoOf(item: ExecutionWorkItem): HostTodo {
	const title = oneLine(
		`${item.pipeline ? "（パイプライン）" : ""}${item.request}`,
		TODO_TITLE_CHARS,
	);
	if (item.heldEventId === null)
		return {
			id: item.id,
			title,
			status: "todo",
			requestedAt: item.createdAt,
		};
	return {
		id: item.id,
		title,
		status: "done",
		outcome: outcomeOf(item.status),
		...(item.resultSummary
			? { result: oneLine(item.resultSummary, TODO_RESULT_CHARS) }
			: {}),
		requestedAt: item.createdAt,
		doneAt: item.updatedAt,
	};
}

/**
 * The agency's view of a conversation's asked-for background work (task executions and pipelines) and the release
 * of held result reports (spec agency-work-reports-design-2026-10-24). A released report is sent as the execution
 * notice it would have been at once; the conversation answers it as before (one report, never two).
 */
export function createAgencyWork(deps: {
	agents: {
		executions: Pick<
			AgentRuntime["executions"],
			| "workItemsInTransaction"
			| "heldReportsInTransaction"
			| "releaseReportInTransaction"
			| "settleEventInTransaction"
			| "viewInTransaction"
			| "sourceRunInTransaction"
		>;
	};
	dialogue: Pick<
		DialogueService,
		"executionSourceInTransaction" | "notifyInTransaction"
	>;
}) {
	const { agents } = deps;
	function release(
		db: Database,
		held: readonly { eventId: string; executionId: string }[],
	): number {
		let sent = 0;
		for (const report of held) {
			// One report at a time: a notice that fails must not keep the others (or itself) held for ever.
			db.exec("SAVEPOINT agency_report_release");
			try {
				if (!agents.executions.releaseReportInTransaction(db, report.eventId)) {
					db.exec("RELEASE agency_report_release");
					continue;
				}
				const view = agents.executions.viewInTransaction(
					db,
					report.executionId,
				);
				if (view && sendExecutionNotice(deps, db, view, report.eventId)) sent++;
				// Nothing left to answer: settle the event so the delivery loop stops polling it.
				else agents.executions.settleEventInTransaction(db, report.eventId);
				db.exec("RELEASE agency_report_release");
			} catch (error) {
				db.exec("ROLLBACK TO agency_report_release");
				db.exec("RELEASE agency_report_release");
				// The notice cannot be sent: the report is closed as failed (logged), never retried in a loop.
				agents.executions.releaseReportInTransaction(db, report.eventId);
				agents.executions.settleEventInTransaction(db, report.eventId);
				getLogger("agency").warn("agency.report_release_failed", {
					subjectId: report.executionId,
					reason: toErrorCode(error, "notice_failed"),
				});
			}
		}
		return sent;
	}
	return {
		todosInTransaction(db: Database, conversationId: string): HostTodo[] {
			return agents.executions
				.workItemsInTransaction(db, conversationId)
				.map(hostTodoOf);
		},
		heldInTransaction(db: Database, conversationId?: string) {
			return agents.executions.heldReportsInTransaction(db, conversationId);
		},
		/** Releases the held reports of these executions in one conversation; returns how many notices were sent. */
		releaseInTransaction(
			db: Database,
			conversationId: string,
			executionIds: readonly string[],
		): number {
			const wanted = new Set(executionIds);
			return release(
				db,
				agents.executions
					.heldReportsInTransaction(db, conversationId)
					.filter((r) => wanted.has(r.executionId)),
			);
		},
		/** Releases every held report (of one conversation when given): nobody will pick a moment for them. */
		releaseAllInTransaction(db: Database, conversationId?: string): number {
			return release(
				db,
				agents.executions.heldReportsInTransaction(db, conversationId),
			);
		},
		/** Releases reports held longer than `maxAgeMs` (a stuck agency must not swallow a report). */
		releaseStaleInTransaction(db: Database, now: number, maxAgeMs: number) {
			return release(
				db,
				agents.executions
					.heldReportsInTransaction(db)
					.filter((r) => now - r.heldAt >= maxAgeMs),
			);
		},
	};
}
export type AgencyWork = ReturnType<typeof createAgencyWork>;
