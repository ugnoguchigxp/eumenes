import type { Database } from "bun:sqlite";
import type { AgencyActionDeps, createAgencyActions } from "./agency-actions";
import {
	agencyWorks,
	agencyWork,
	agencyRecords,
	currentAgencyWork,
	autonomousActionSource,
	returnAgencyWork,
	type AgencyWorkRow,
} from "../repository/agency";
import { isAgendaSnapshot } from "../contracts/agency-always-on";

/**
 * The user's words an assignment runs as (the source its toolchain took the work under), or null for the agency's own
 * work. An assignment is held to those words, not to the agency's own grant: a toolchain revoked meanwhile still
 * reports how its work ended (a failure), where the agency's own work, made invalid by the revocation, is dropped.
 */
function assignmentSource(db: Database, w: AgencyWorkRow) {
	const record = agencyRecords(db).find(
		(r) => r.conversationId === w.conversation_id && r.epoch === w.epoch,
	);
	if (!record || !isAgendaSnapshot(record.snapshot)) return null;
	const ticket = record.snapshot.tickets.find((t) => t.id === w.ticket_id);
	return ticket?.assignment
		? (record.snapshot.assignments?.find((a) => a.itemId === ticket.itemId)
				?.source ?? null)
		: null;
}

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
					// The execution is gone (its owner forgot it): the work ends here, or the agent
					// would wait on its ticket for ever.
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
					// The work failed because its toolchain was revoked meanwhile: the owner's result is only the
					// stop it made of its own work, so the work ends under the reason.
					const revoked =
						view.status === "failed" &&
						!!deps.toolchains &&
						!deps.toolchains.cardInTransaction(db, w.toolchain_revision_id);
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
							summary: revoked
								? "capability_revoked"
								: JSON.stringify(view.result),
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
				const own = autonomousActionSource(db, rootId, deps.now());
				const source = own && (assignmentSource(db, w) ?? own);
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
				// Nothing is left to adopt of an execution that is gone.
				if (!view) {
					actions.discard(db, rootId);
					returnAgencyWork(db, rootId);
					return false;
				}
				if (!view.result) return false;
				try {
					actions.synchronize(db, view, rootId);
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
