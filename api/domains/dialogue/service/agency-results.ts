import type { Database } from "bun:sqlite";
import type { AgencyActionDeps, createAgencyActions } from "./agency-actions";
import {
	agencyWorks,
	agencyWork,
	currentAgencyWork,
	autonomousActionSource,
	returnAgencyWork,
} from "../repository/agency";

/** Reconciles both historical read-only work and shared action executions before releasing their authority. */
export function agencyResults(
	deps: AgencyActionDeps,
	actions: ReturnType<typeof createAgencyActions>,
) {
	return {
		resultsInTransaction(db: Database) {
			return agencyWorks(db).flatMap((w) => {
				if (!currentAgencyWork(db, w))
					return [
						{
							rootId: w.root_id,
							conversationId: w.conversation_id,
							epoch: w.epoch,
							ticketId: w.ticket_id,
							status: "interrupted" as const,
							workStatus: "interrupted" as const,
							summary: "意図の終了または撤回により中止しました。",
							general: !!w.execution_id,
							cancel: true,
						},
					];
				if (w.execution_id) {
					const view = actions.result(db, w.root_id);
					// The execution is gone (its owner forgot it): the work ends here, or its TODO would stay open
					// for ever and the ticket would never come back.
					if (!view)
						return [
							{
								general: true,
								cancel: false,
								rootId: w.root_id,
								conversationId: w.conversation_id,
								epoch: w.epoch,
								ticketId: w.ticket_id,
								status: "failed" as const,
								workStatus: "failed" as const,
								summary: "agency_execution_lost",
							},
						];
					if (!view.result) return [];
					return [
						{
							general: true,
							cancel: false,
							rootId: w.root_id,
							conversationId: w.conversation_id,
							epoch: w.epoch,
							ticketId: w.ticket_id,
							status:
								view.status === "completed" || view.status === "partial"
									? ("succeeded" as const)
									: view.status === "cancelled" || view.status === "interrupted"
										? ("interrupted" as const)
										: ("failed" as const),
							workStatus:
								view.status === "completed"
									? ("succeeded" as const)
									: view.status === "partial"
										? ("partial" as const)
										: view.status === "cancelled" ||
											  view.status === "interrupted"
											? ("interrupted" as const)
											: ("failed" as const),
							summary: JSON.stringify(view.result),
						},
					];
				}
				const task = w.task_id
					? deps.agents?.getInTransaction(db, w.task_id)
					: null;
				if (
					!task ||
					![
						"completed",
						"failed",
						"cancelled",
						"interrupted",
						"ready_for_answer",
					].includes(task.status)
				)
					return [];
				let summary = task.errorCode ?? task.status;
				let partial = false;
				let successful =
					["completed", "ready_for_answer"].includes(task.status) &&
					!task.errorCode;
				if (successful) {
					try {
						if (task.status === "ready_for_answer") {
							const ticket = deps.agents!.prepareAnswerInTransaction(
								db,
								w.root_id,
							);
							if (!deps.agents!.validAnswerInTransaction(db, ticket))
								throw new Error("agency_result_invalidated");
						}
						const report = deps.agents!.reportInTransaction(db, w.task_id!);
						if (!report) throw new Error("agency_result_invalidated");
						partial = report.coverage === "partial";
						summary = JSON.stringify(report);
					} catch {
						successful = false;
						summary = "agency_result_invalidated";
					}
				}
				return [
					{
						general: false,
						cancel: false,
						rootId: w.root_id,
						conversationId: w.conversation_id,
						epoch: w.epoch,
						ticketId: w.ticket_id,
						status: successful
							? ("succeeded" as const)
							: task.status === "cancelled" || task.status === "interrupted"
								? ("interrupted" as const)
								: ("failed" as const),
						workStatus:
							task.errorCode === "clarification_required"
								? ("question" as const)
								: successful
									? partial
										? ("partial" as const)
										: ("succeeded" as const)
									: task.status === "cancelled" || task.status === "interrupted"
										? ("interrupted" as const)
										: ("failed" as const),
						summary:
							summary.length > 12000
								? summary.slice(0, 12000) + "（結果の残りは省略）"
								: summary,
					},
				];
			});
		},
		returnedInTransaction(db: Database, rootId: string) {
			const w = agencyWork(db, rootId);
			let adopted = true;
			if (w?.execution_id) {
				const source = autonomousActionSource(
					db,
					rootId,
					deps.now(),
					deps.settings?.inTransaction(db),
				);
				if (
					!currentAgencyWork(db, w) ||
					!source ||
					!deps.execution?.()?.validSourceInTransaction(db, source)
				) {
					actions.discard(db, rootId);
					returnAgencyWork(db, rootId);
					return false;
				}
				const view = actions.result(db, rootId);
				// Nothing is left to adopt of an execution that is gone: its TODO is closed with it.
				if (!view) {
					actions.discard(db, rootId);
					returnAgencyWork(db, rootId);
					return false;
				}
				if (!view.result) return false;
				try {
					actions.synchronize(db, view);
				} catch (error) {
					if (
						!(error instanceof Error) ||
						error.message !== "agency_result_invalidated"
					)
						throw error;
					actions.discard(db, rootId);
					returnAgencyWork(db, rootId);
					return false;
				}
				returnAgencyWork(db, rootId);
				return true;
			}
			if (
				w?.task_id &&
				deps.agents?.getInTransaction(db, w.task_id)?.status ===
					"ready_for_answer"
			) {
				try {
					const ticket = deps.agents.prepareAnswerInTransaction(db, rootId);
					deps.agents.completeAnswerInTransaction(db, ticket);
				} catch {
					adopted = false;
					deps.agents.failAnswerInTransaction(
						db,
						rootId,
						"agency_result_invalidated",
					);
				}
			}
			returnAgencyWork(db, rootId);
			return adopted;
		},
	};
}
