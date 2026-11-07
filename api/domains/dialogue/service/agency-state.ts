import { createAgencyActions, type AgencyActionDeps } from "./agency-actions";
import { agencyForgetting } from "./agency-forgetting";
import { refreshAgencyDependencies } from "./agency-memory";
import { staleAgencySources } from "./agency-sources";
import type { Database } from "bun:sqlite";
import {
	currentAgencyWork,
	revokeAgencyWork,
	agencyRecords,
	claimAgencyDispatch,
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
import type { MemoryService } from "../../memory";
import type { AgentRuntime } from "../../agent-runtime";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
import {
	agencyObservations,
	saveAgencyObservation,
	deleteAgencyObservation,
	agencyDependents,
	replaceAgencyDependents,
} from "../repository/agency-observations";

export function createAgencyStatePort(deps: AgencyActionDeps & {
	agents?: AgentRuntime;
	toolchains?: ToolchainRoutingPort | undefined;
	now: () => number;
	memory?: Pick<MemoryService, "referenceInputs">;
}) {
	const actions = createAgencyActions(deps);
	const revoke = (db: Database, id: string) => {
		for (const w of agencyWorks(db, id, true)) {
			if (w.execution_id) deps.agents?.executions.forgetInTransaction(db,w.execution_id);
			deps.agents?.deleteTaskDataInTransaction(db, w.root_id);
		}
		revokeAgency(db, id);
	};
	const catalog = (db: Database) =>
		actions.available() ? actions.catalog(db) : (deps.toolchains?.catalogInTransaction(db) ?? []).flatMap((entry) => {
			// Runtime routes are execution contracts, not semantic topic judgments.
			// They are checked first: a card reads the whole toolchain set, and this runs per agency checkpoint.
			if (
				entry.runtime.binding ||
				(entry.runtime.route !== "web" && entry.runtime.route !== "history")
			)
				return [];
			const card = deps.toolchains!.cardInTransaction(db, entry.revisionId);
			return card && (card.minImpact === undefined || card.minImpact === "none")
				? [
						{
							revisionId: card.revisionId,
							title: card.title,
							description: card.summary,
						},
					]
				: [];
		});
	return {
		quarantineLegacyInTransaction(db: Database) {
			for (const record of agencyRecords(db))
				if (
					!(record.snapshot as import("eumenes-agency").AgencySnapshot)
						.provenance
				)
					revoke(db, record.conversationId);
		},
		staleSourcesInTransaction: (db: Database, refs: readonly string[]) =>
			staleAgencySources(
				db,
				refs,
				catalog(db).map((c) => c.revisionId),
			),
		observationsInTransaction: agencyObservations,
		messageInputInTransaction(db: Database, messageId: string) {
			for (const record of agencyRecords(db)) {
				const snapshot =
					record.snapshot as import("eumenes-agency").AgencySnapshot;
				const attempt = snapshot.state.attempts?.find(
					(a) => messageId === `agency:${record.scope}:${a.id}`,
				);
				if (!attempt) continue;
				return (
					snapshot.provenance?.entries.find(
						([key]) => key === `attempt:${attempt.id}`,
					)?.[1] ?? null
				);
			}
			return null;
		},
		refreshDependenciesInTransaction(
			db: Database,
			conversationId: string,
			scope: string,
			refs: readonly string[],
		) {
			refreshAgencyDependencies(db, deps.memory, conversationId, scope, refs);
		},
		saveObservationInTransaction: saveAgencyObservation,
		deleteObservationInTransaction: deleteAgencyObservation,
		dependentsInTransaction: agencyDependents,
		replaceDependentsInTransaction: replaceAgencyDependents,
		recordsInTransaction(db: Database) {
			return agencyRecords(db).map((record) => {
				const snap =
					record.snapshot as import("eumenes-agency").AgencySnapshot & {
						memoryObservations?: boolean;
					};
				if (!snap.memoryObservations) return record;
				if (!deps.memory) throw new Error("agency_memory_unavailable");
				const rows = agencyObservations(db, record.conversationId).filter(
					(row) => row.scope === record.scope,
				);
				const observations = snap.observations.map((observation) => {
					if (snap.forgottenRefs?.includes(observation.id)) return observation;
					const row = rows.find((row) => row.observationId === observation.id);
					const found =
						row &&
						deps.memory!.referenceInputs.readRecordInTransaction(db, {
							recordId: row.ref.id,
							revision: row.ref.revision,
						});
					if (!found || found.ref.digest !== row!.ref.digest)
						throw new Error("agency_archive_unavailable");
					const entry = JSON.parse(
						found.content,
					) as import("eumenes-agency").ArchivedObservation;
					if (entry.observation.id !== observation.id)
						throw new Error("agency_archive_mismatch");
					return entry.observation;
				});
				return { ...record, snapshot: { ...snap, observations } };
			});
		},
		claimDispatchInTransaction: claimAgencyDispatch,
		epochInTransaction: agencyEpoch,
		feedInTransaction: agencyFeed,
		saveInTransaction: saveAgency,
		saveFeedInTransaction: saveAgencyFeed,
		catalogInTransaction: catalog,
		findCapabilities: actions.find,
		generalActionsAvailable: actions.available,
		linkFindingsInTransaction(db: Database, conversationId: string, messageId: string, ticketIds: readonly string[]) { actions.link(db,conversationId,messageId,agencyWorks(db,conversationId,true).filter((w)=>ticketIds.includes(w.ticket_id)).flatMap((w)=>w.execution_id ? [w.execution_id] : [])); },
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
				outboundIntervalMs: number;
				sourceRefs: readonly string[];
				arguments?: Record<string, unknown>;
			},
		) {
			if (actions.available()) return actions.start(db,input);
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
			if (!catalog(db).some((c) => c.revisionId === input.revisionId))
				throw new Error("agency_capability_unavailable");
			const resolved = deps.toolchains.resolveInTransaction(
				db,
				input.revisionId,
			);
			if (
				!claimAgencyDispatch(
					db,
					input.conversationId,
					input.epoch,
					deps.now(),
					input.outboundIntervalMs,
				)
			)
				throw new Error("agency_dispatch_interval");
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
                if (w.execution_id) {
                  const view = actions.result(db,w.root_id);
                  if (!view?.result) return [];
                  return [{cancel:false,rootId:w.root_id,conversationId:w.conversation_id,epoch:w.epoch,ticketId:w.ticket_id,status:view.status === "completed" || view.status === "partial" ? "succeeded" as const : view.status === "cancelled" || view.status === "interrupted" ? "interrupted" as const : "failed" as const,workStatus:view.status === "completed" ? "succeeded" as const : view.status === "partial" ? "partial" as const : view.status === "cancelled" || view.status === "interrupted" ? "interrupted" as const : "failed" as const,summary:JSON.stringify(view.result)}];
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
              if (!currentAgencyWork(db,w)) { returnAgencyWork(db,rootId); return false; }
              const view = actions.result(db,rootId);
              if (!view?.result) return false;
              actions.synchronize(db,view);
              returnAgencyWork(db,rootId);
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
		cancelInTransaction(db: Database, id: string) {
			actions.cancel(db,id);
			deps.agents?.deleteTaskDataInTransaction(db, id);
			revokeAgencyWork(db, id);
		},
		revokeInTransaction: revoke,
		...agencyForgetting(deps),
	};
}
export type AgencyStatePort = ReturnType<typeof createAgencyStatePort>;
export type { AgencyRecord };
