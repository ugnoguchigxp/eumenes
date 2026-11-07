import { stopAgencyExecution } from "./agency-actions";
import { eraseAgencyActionWork } from "./agency-action-work";
import type { Database } from "bun:sqlite";
import {
	prepareForgetting,
	type AgencySnapshot,
	type InputContext,
} from "eumenes-agency";
import type { AgentRuntime } from "../../agent-runtime";
import type { MemoryService, ForgetPurge } from "../../memory";
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
	type AgencyObservationRef,
} from "../repository/agency-observations";
import { refreshAgencyDependencies } from "./agency-memory";

type ForgetSources = {
	messageIds: readonly string[];
	itemIds: readonly string[];
	sourceRefs?: readonly string[];
	forgetIds?: readonly string[];
	derived?: ForgetPurge["derived"];
	/** A known lost observation is local to its persisted runtime; ordinary source forgetting stays global. */
	target?: { conversationId: string; scope: string };
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

const erased = (row: AgencyObservationRef, input: ForgetSources) =>
	affected(row.input, references(input)) ||
	references(input).has(row.observationId) ||
	(input.derived?.["memory.records"] ?? []).includes(row.ref.id);

function observationReferences(
	rows: readonly AgencyObservationRef[],
	conversationId: string,
	scope: string,
	input: ForgetSources,
) {
	return [
		...new Set([
			...references(input),
			...rows
				.filter(
					(row) =>
						row.conversationId === conversationId &&
						row.scope === scope &&
						erased(row, input),
				)
				.map((row) => row.observationId),
		]),
	];
}

export function agencyForgetting(deps: {
	agents?: AgentRuntime;
	toolchains?: import("../contracts/toolchains").ToolchainRoutingPort;
	memory?: Pick<MemoryService, "referenceInputs">;
	now(): number;
}) {
	return {
		forgetReferencesInTransaction(
			db: Database,
			conversationId: string,
			scope: string,
			input: ForgetSources,
		) {
			return observationReferences(
				agencyObservations(db, conversationId),
				conversationId,
				scope,
				input,
			);
		},
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
			if (!refs.size && !input.derived?.["memory.records"]?.length) return [];
			const changed: string[] = [];
			const oldDependents: string[] = [];
			const observations = agencyObservations(db).filter(
				(row) =>
					!input.target ||
					(row.conversationId === input.target.conversationId &&
						row.scope === input.target.scope),
			);
			if (!input.sourceRefs?.length)
				for (const row of observations)
					if (erased(row, input)) deleteAgencyObservation(db, row);
			for (const record of agencyRecords(db)) {
				if (
					input.target &&
					(record.conversationId !== input.target.conversationId ||
						record.scope !== input.target.scope)
				)
					continue;
				const snapshot = record.snapshot as AgencySnapshot;
				if (
					!Array.isArray(snapshot.observations) ||
					!Array.isArray(snapshot.state?.candidates)
				) {
					if (!record.sourceRefs.some((ref) => refs.has(ref))) continue;
					for (const work of agencyWorks(db, record.conversationId, true)) {
						if (work.execution_id)
							eraseAgencyActionWork(db, work.execution_id, deps.now());
						if (work.execution_id) stopAgencyExecution(deps, db, work, true);
						deps.agents?.deleteTaskDataInTransaction(db, work.root_id);
					}
					revokeAgency(db, record.conversationId);
					changed.push(record.conversationId);
					continue;
				}
				const recordRefs = observationReferences(
					observations,
					record.conversationId,
					record.scope,
					input,
				);
				if (!recordRefs.length) continue;
				const next = prepareForgetting(snapshot, recordRefs).checkpoint;
				const retained = new Set(next.state.attempts.map((a) => a.id));
				for (const work of agencyWorks(db, record.conversationId, true))
					if (
						!retained.has(work.ticket_id) ||
						(work.source_refs_json &&
							(JSON.parse(work.source_refs_json) as string[]).some((ref) =>
								refs.has(ref),
							))
					) {
						if (work.execution_id)
							eraseAgencyActionWork(db, work.execution_id, deps.now());
						if (work.execution_id) stopAgencyExecution(deps, db, work, true);
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
