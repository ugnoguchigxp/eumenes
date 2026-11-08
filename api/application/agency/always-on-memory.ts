import type { Database } from "bun:sqlite";
import {
	isAlwaysOnSnapshot,
	type AgencyRecord,
	type AlwaysOnHostSnapshot,
} from "../../domains/dialogue";
import type { AgencyHostDeps } from "./host-types";
import { staleInputSources } from "./input";

/** Reuse the same canonical Records and dependency registry as the adopted host. */
export function persistAlwaysOnMemory(
	deps: AgencyHostDeps,
	db: Database,
	record: AgencyRecord,
): AgencyRecord {
	if (!isAlwaysOnSnapshot(record.snapshot))
		throw new Error("agency_snapshot_invalid");
	const snap = record.snapshot;
	const memory = deps.memory.referenceInputs;
	if (!memory || !deps.state) throw new Error("agency_memory_unavailable");
	if (staleInputSources(deps, db, record.sourceRefs).length)
		throw new Error("agency_input_stale");
	const inputs = new Map(snap.agent.observationInputs);
	const rows = new Map(
		deps.state
			.observationsInTransaction(db, record.conversationId)
			.filter((r) => r.scope === record.scope)
			.map((r) => [r.observationId, r]),
	);
	for (const observation of snap.agent.observations) {
		const input = inputs.get(observation.id);
		if (!input?.complete) throw new Error("agency_input_incomplete");
		const content = JSON.stringify({ observation, input });
		const previous = rows.get(observation.id);
		if (previous) {
			const old = memory.readRecordInTransaction(db, {
				recordId: previous.ref.id,
				revision: previous.ref.revision,
			});
			if (!old || old.content !== content)
				throw new Error("agency_archive_conflict");
			continue;
		}
		const ref = memory.captureRecordInTransaction(db, {
			origin: {
				namespace: "agency",
				kind: "observation",
				id: `${record.scope}:${observation.id}`,
			},
			mediaType: "application/json",
			content,
		});
		deps.state.saveObservationInTransaction(db, {
			conversationId: record.conversationId,
			scope: record.scope,
			observationId: observation.id,
			ref,
			input,
		});
	}
	deps.state.refreshDependenciesInTransaction(
		db,
		record.conversationId,
		record.scope,
		record.sourceRefs,
	);
	const snapshot: AlwaysOnHostSnapshot = {
		...snap,
		memoryObservations: true,
		agent: {
			...snap.agent,
			observations: snap.agent.observations.map((o) => ({ ...o, text: "" })),
		},
	};
	return { ...record, snapshot };
}
