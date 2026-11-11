import { readAgencyRecords } from "./agency-state-memory";
import { agencyResults } from "./agency-results";
import { isAgendaSnapshot } from "../contracts/agency-always-on";
import { eraseAgencyActionWork } from "./agency-action-work";
import {
	createAgencyActions,
	stopAgencyExecution,
	type AgencyActionDeps,
} from "./agency-actions";
import { agencyForgetting } from "./agency-forgetting";
import { refreshAgencyDependencies } from "./agency-memory";
import { staleAgencySources } from "./agency-sources";
import type { Database } from "bun:sqlite";
import {
	revokeAgencyWork,
	agencyWorkActive,
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

export function createAgencyStatePort(
	deps: AgencyActionDeps & {
		agents?: AgentRuntime;
		toolchains?: ToolchainRoutingPort | undefined;
		now: () => number;
		memory?: Pick<MemoryService, "referenceInputs">;
	},
) {
	const actions = createAgencyActions(deps);
	const forgetting = agencyForgetting(deps);
	const revoke = (db: Database, id: string) => {
		for (const w of agencyWorks(db, id, true)) {
			if (w.execution_id) eraseAgencyActionWork(db, w.execution_id, deps.now());
			if (w.execution_id) stopAgencyExecution(deps, db, w, true);
			deps.agents?.deleteTaskDataInTransaction(db, w.root_id);
		}
		revokeAgency(db, id);
	};
	const catalog = (db: Database) =>
		actions.available()
			? actions.catalog(db)
			: (deps.toolchains?.catalogInTransaction(db) ?? []).flatMap((entry) => {
					// Runtime routes are execution contracts, not semantic topic judgments.
					// They are checked first: a card reads the whole toolchain set, and this runs per agency checkpoint.
					if (
						entry.selectable === false ||
						entry.runtime.binding ||
						(entry.runtime.route !== "web" && entry.runtime.route !== "history")
					)
						return [];
					const card = deps.toolchains!.cardInTransaction(db, entry.revisionId);
					return card &&
						(card.minImpact === undefined || card.minImpact === "none")
						? [
								{
									revisionId: card.revisionId,
									title: card.title,
									description: card.summary,
									requiresApproval: false,
									reason: "available",
								},
							]
						: [];
				});
	return {
		recoverForgottenInTransaction(db: Database) {
			if (!deps.memory) return;
			// Remove tombstoned Record references before re-registering any retained dependencies.
			const recordIds = agencyObservations(db)
				.filter((row) =>
					deps.memory!.referenceInputs.isRecordForgottenInTransaction(
						db,
						row.ref.id,
					),
				)
				.map((row) => row.ref.id);
			if (recordIds.length)
				forgetting.forgetInTransaction(db, {
					messageIds: [],
					itemIds: [],
					derived: { "memory.records": recordIds },
				});
			for (const record of agencyRecords(db)) {
				const snap =
					record.snapshot as import("eumenes-agency").AgencySnapshot & {
						memoryObservations?: boolean;
					};
				if (!isAgendaSnapshot(record.snapshot) && snap.memoryObservations) {
					const archived = new Set(
						agencyObservations(db, record.conversationId)
							.filter((row) => row.scope === record.scope)
							.map((row) => row.observationId),
					);
					const forgotten = snap.observations
						.filter(
							(o) =>
								!archived.has(o.id) &&
								!snap.forgottenRefs?.includes(o.id) &&
								deps.memory!.referenceInputs.isRecordOriginForgottenInTransaction(
									db,
									{
										namespace: "agency",
										kind: "observation",
										id: `${record.scope}:${o.id}`,
									},
								),
						)
						.map((o) => o.id);
					if (forgotten.length)
						forgetting.forgetInTransaction(db, {
							messageIds: [],
							itemIds: [],
							sourceRefs: forgotten,
							target: {
								conversationId: record.conversationId,
								scope: record.scope,
							},
						});
				}
				const stale = deps.memory.referenceInputs.staleInTransaction(
					db,
					record.sourceRefs,
				);
				if (stale.length)
					forgetting.forgetInTransaction(db, {
						messageIds: [],
						itemIds: [],
						sourceRefs: stale,
					});
			}
		},
		quarantineLegacyInTransaction(db: Database) {
			for (const record of agencyRecords(db))
				if (
					!isAgendaSnapshot(record.snapshot) &&
					!(record.snapshot as import("eumenes-agency").AgencySnapshot | null)
						?.provenance
				)
					revoke(db, record.conversationId);
		},
		workActiveInTransaction: (db: Database, rootId: string) =>
			agencyWorkActive(db, rootId),
		staleSourcesInTransaction: (db: Database, refs: readonly string[]) =>
			staleAgencySources(
				db,
				refs,
				catalog(db).map((c) => c.revisionId),
			),
		observationsInTransaction: agencyObservations,
		messageInputInTransaction(db: Database, messageId: string) {
			for (const record of agencyRecords(db)) {
				// The agenda's speech records its own input with the message (Memory keeps it).
				if (isAgendaSnapshot(record.snapshot)) continue;
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
		recordsInTransaction: (db: Database) => readAgencyRecords(db, deps.memory),
		claimDispatchInTransaction: claimAgencyDispatch,
		epochInTransaction: agencyEpoch,
		feedInTransaction: agencyFeed,
		saveInTransaction: saveAgency,
		saveFeedInTransaction: saveAgencyFeed,
		catalogInTransaction: catalog,
		findCapabilities: actions.find,
		generalActionsAvailable: actions.available,
		linkFindingsInTransaction(
			db: Database,
			conversationId: string,
			messageId: string,
			ticketIds: readonly string[],
		) {
			actions.link(
				db,
				conversationId,
				messageId,
				agencyWorks(db, conversationId, true)
					.filter((w) => ticketIds.includes(w.ticket_id))
					.flatMap((w) => (w.execution_id ? [w.execution_id] : [])),
			);
		},
		startInTransaction(
			db: Database,
			input: {
				rootId: string;
				conversationId: string;
				epoch: number;
				ticketId: string;
				intentId?: string;
				candidateId?: string;
				question: string;
				revisionId: string;
				deadline: number;
				outboundIntervalMs: number;
				sourceRefs: readonly string[];
				arguments?: Record<string, unknown>;
			},
		) {
			if (actions.available()) return actions.start(db, input);
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
				intent_id: input.intentId ?? "",
				candidate_id: input.candidateId ?? "",
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
		...agencyResults(deps, actions),
		cancelInTransaction(db: Database, id: string) {
			actions.cancel(db, id);
			deps.agents?.deleteTaskDataInTransaction(db, id);
			revokeAgencyWork(db, id);
		},
		revokeInTransaction: revoke,
		...forgetting,
	};
}
export type AgencyStatePort = ReturnType<typeof createAgencyStatePort>;
export type { AgencyRecord };
