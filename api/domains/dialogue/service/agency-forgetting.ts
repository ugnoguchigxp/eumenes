import type { Database } from "bun:sqlite";
import {
	prepareForgetting,
	type AgencySnapshot,
	type InputContext,
} from "eumenes-agency";
import type { AgentRuntime } from "../../agent-runtime";
import type { MemoryService } from "../../memory";
import {
	agencyRecords,
	agencyWorks,
	revokeAgency,
	saveAgency,
	revokeAgencyWork,
} from "../repository/agency";
import {
	agencyObservations,
	deleteAgencyObservation,
	agencyDependents,
} from "../repository/agency-observations";
import { refreshAgencyDependencies } from "./agency-memory";

type ForgetSources = {
	messageIds: readonly string[];
	itemIds: readonly string[];
	sourceRefs?: readonly string[];
	forgetIds?: readonly string[];
};
const references = (input: ForgetSources) =>
	new Set([
		...input.messageIds,
		...input.itemIds.map((id) => `memory:${id}`),
		...(input.sourceRefs ?? []),
	]);
const affected = (input: InputContext, refs: ReadonlySet<string>) =>
	refs.size > 0 &&
	(!input.complete || input.sources.some((ref) => refs.has(ref)));

export function agencyForgetting(deps: {
	agents?: AgentRuntime;
	memory?: Pick<MemoryService, "referenceInputs">;
	now(): number;
}) {
	return {
		planForgetInTransaction(db: Database, input: ForgetSources) {
			const refs = references(input);
			return {
				"memory.records": agencyObservations(db)
					.filter(
						(row) => affected(row.input, refs) || refs.has(row.observationId),
					)
					.map((row) => row.ref.id),
			};
		},
		forgetInTransaction(db: Database, input: ForgetSources): string[] {
			const refs = references(input);
			if (!refs.size) return [];
			const changed: string[] = [];
			const oldDependents: string[] = [];
			if (!input.sourceRefs?.length)
				for (const row of agencyObservations(db))
					if (affected(row.input, refs) || refs.has(row.observationId))
						deleteAgencyObservation(db, row);
			for (const record of agencyRecords(db)) {
				const snapshot = record.snapshot as AgencySnapshot;
				if (
					!Array.isArray(snapshot.observations) ||
					!Array.isArray(snapshot.state?.candidates)
				) {
					if (!record.sourceRefs.some((ref) => refs.has(ref))) continue;
					for (const work of agencyWorks(db, record.conversationId, true)) {
						if (work.execution_id) deps.agents?.executions.forgetInTransaction(db,work.execution_id);
						deps.agents?.deleteTaskDataInTransaction(db, work.root_id);
					}
					revokeAgency(db, record.conversationId);
					changed.push(record.conversationId);
					continue;
				}
				const next = prepareForgetting(snapshot, [...refs]).checkpoint;
				const retained = new Set(next.state.attempts.map((a) => a.id));
				for (const work of agencyWorks(db, record.conversationId, true))
					if (
						!retained.has(work.ticket_id) ||
						(work.source_refs_json &&
							(JSON.parse(work.source_refs_json) as string[]).some((ref) =>
								refs.has(ref),
							))
					) {
						if (work.execution_id) deps.agents?.executions.forgetInTransaction(db,work.execution_id);
						deps.agents?.deleteTaskDataInTransaction(db, work.root_id);
						revokeAgencyWork(db, work.root_id);
					}
				const sourceRefs = [
					...new Set([
						...next.observations.map((o) => o.id),
						...(next.provenance?.entries.flatMap(([, i]) => i.sources) ?? []),
					]),
				];
				if (
					!saveAgency(db, { ...record, snapshot: next, sourceRefs }, deps.now())
				)
					throw new Error("agency_checkpoint_stale");
				if (deps.memory) {
					oldDependents.push(...agencyDependents(db, record.conversationId));
					refreshAgencyDependencies(
						db,
						deps.memory,
						record.conversationId,
						record.scope,
						sourceRefs,
					);
				}
				changed.push(record.conversationId);
			}
			if (input.forgetIds?.length && deps.memory)
				deps.memory.referenceInputs.confirmDeletionInTransaction(
					db,
					input.forgetIds,
					"agency",
					oldDependents,
				);
			return changed;
		},
	};
}
