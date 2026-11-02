import type { Database } from "bun:sqlite";
import {
	currentAgencyWork,
	revokeAgencyWork,
	agencyRecords,
	agencyEpoch,
	saveAgency,
	agencyFeed,
	saveAgencyFeed,
	agencyWorks,
	agencyWork,
	insertAgencyWork,
	linkAgencyWork,
	returnAgencyWork,
	revokeAgency,
	type AgencyRecord,
} from "../repository/agency";
import type { AgentRuntime } from "../../agent-runtime";
import type { ToolchainRoutingPort } from "../contracts/toolchains";

export function createAgencyStatePort(deps: {
	agents?: AgentRuntime;
	toolchains?: ToolchainRoutingPort | undefined;
	now: () => number;
}) {
	const catalog = (db: Database) =>
		(deps.toolchains?.catalogInTransaction(db) ?? []).flatMap((entry) => {
			const card = deps.toolchains!.cardInTransaction(db, entry.revisionId);
			// Runtime routes are execution contracts, not semantic topic judgments.
			return card &&
				(card.minImpact ?? "read") === "read" &&
				!entry.runtime.binding &&
				(entry.runtime.route === "web" || entry.runtime.route === "history")
				? [
						{
							id: card.revisionId,
							title: card.title,
							description: card.summary,
						},
					]
				: [];
		});
	return {
		recordsInTransaction: agencyRecords,
		epochInTransaction: agencyEpoch,
		feedInTransaction: agencyFeed,
		saveInTransaction: saveAgency,
		saveFeedInTransaction: saveAgencyFeed,
		catalogInTransaction: catalog,
		startInTransaction(
			db: Database,
			input: {
				rootId: string;
				conversationId: string;
				epoch: number;
				ticketId: string;
				intentId: string;
				candidateId: string;
				question: string;
				revisionId: string;
				deadline: number;
				sourceRefs: readonly string[];
			},
		) {
			if (!deps.agents || !deps.toolchains)
				throw new Error("agency_research_unavailable");
			if (
				agencyEpoch(db, input.conversationId) !== input.epoch ||
				input.deadline <= deps.now()
			)
				throw new Error("agency_origin_stale");
			const found = agencyWork(db, input.rootId);
			if (found) {
				if (found.revoked) throw new Error("agency_origin_stale");
				return found.task_id;
			}
			if (!catalog(db).some((c) => c.id === input.revisionId))
				throw new Error("agency_capability_unavailable");
			const resolved = deps.toolchains.resolveInTransaction(
				db,
				input.revisionId,
			);
			insertAgencyWork(db, {
				root_id: input.rootId,
				conversation_id: input.conversationId,
				epoch: input.epoch,
				ticket_id: input.ticketId,
				intent_id: input.intentId,
				candidate_id: input.candidateId,
				question: input.question,
				toolchain_revision_id: input.revisionId,
				deadline: input.deadline,
				source_refs_json: JSON.stringify(input.sourceRefs),
			});
			const result = deps.agents.startInTransaction(db, {
				rootRunId: input.rootId,
				input: {
					kind: resolved.runtime.route,
					autonomous: true,
					question: input.question,
					originalRequest: input.question,
					packageRevisionId: resolved.packageRevisionId,
				},
				deadline: input.deadline,
			});
			linkAgencyWork(db, input.rootId, result.taskId);
			return result.taskId;
		},
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
							cancel: true,
						},
					];
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
		cancelInTransaction(db: Database, id: string) {
			deps.agents?.deleteTaskDataInTransaction(db, id);
			revokeAgencyWork(db, id);
		},
		revokeInTransaction(db: Database, id: string) {
			for (const w of agencyWorks(db, id, true))
				deps.agents?.deleteTaskDataInTransaction(db, w.root_id);
			revokeAgency(db, id);
		},
		forgetInTransaction(
			db: Database,
			input: { messageIds: readonly string[]; itemIds: readonly string[] },
		) {
			const refs = new Set([
				...input.messageIds,
				...input.itemIds.map((id) => `memory:${id}`),
			]);
			const ids = agencyRecords(db)
				.filter((r) => r.sourceRefs.some((ref) => refs.has(ref)))
				.map((r) => r.conversationId);
			for (const id of ids) {
				for (const w of agencyWorks(db, id, true))
					deps.agents?.deleteTaskDataInTransaction(db, w.root_id);
				revokeAgency(db, id);
			}
			return ids;
		},
	};
}
export type AgencyStatePort = ReturnType<typeof createAgencyStatePort>;
export type { AgencyRecord };
