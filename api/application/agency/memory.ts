import type { Database } from "bun:sqlite";
import type {
	ArchivedObservation,
	AgencySnapshot,
	InputContext,
} from "eumenes-agency";
import { prepareCompaction } from "eumenes-agency";
import type { AgencyRecord } from "../../domains/dialogue";
import type { AgencyHostDeps, Conv } from "./host-types";
import { combineInput, staleInputSources } from "./input";

export function dependsOn(input: InputContext, refs: ReadonlySet<string>) {
	return (
		refs.size > 0 &&
		(!input.complete || input.sources.some((ref) => refs.has(ref)))
	);
}

/** Bodies live in Memory Records. The dialogue owner keeps only identity and dependency metadata. */
export function archiveOf(deps: AgencyHostDeps, c: Pick<Conv, "id" | "scope">) {
	return {
		get(id: string): ArchivedObservation | undefined {
			if (!deps.state || !deps.memory.referenceInputs) return undefined;
			return deps.store.read((db) => {
				const row = deps
					.state!.observationsInTransaction(db, c.id)
					.find((row) => row.scope === c.scope && row.observationId === id);
				if (
					!row ||
					deps.memory.referenceInputs!.staleInTransaction(db, row.input.sources)
						.length
				)
					return undefined;
				const record = deps.memory.referenceInputs!.readRecordInTransaction(
					db,
					{ recordId: row.ref.id, revision: row.ref.revision },
				);
				if (!record || record.ref.digest !== row.ref.digest) return undefined;
				const entry = JSON.parse(record.content) as ArchivedObservation;
				if (entry.observation.id !== id)
					throw new Error("agency_archive_mismatch");
				return entry;
			});
		},
	};
}

/**
 * Archives the observations of the records saved in one write. The input check is one pass over all their
 * sources: staleness is decided per source, and a checkpoint carries every conversation of the host.
 */
export function persistMemory(
	deps: AgencyHostDeps,
	db: Database,
	records: readonly AgencyRecord[],
): AgencyRecord[] {
	const memory = deps.memory.referenceInputs;
	const state = deps.state;
	if (!memory || !state) return [...records];
	const sources = [...new Set(records.flatMap((r) => r.sourceRefs))];
	if (staleInputSources(deps, db, sources).length)
		throw new Error("agency_input_stale");
	return records.map((record) => archiveRecord(memory, state, db, record));
}

function archiveRecord(
	memory: NonNullable<AgencyHostDeps["memory"]["referenceInputs"]>,
	state: NonNullable<AgencyHostDeps["state"]>,
	db: Database,
	record: AgencyRecord,
): AgencyRecord {
	const snapshot = record.snapshot as AgencySnapshot;
	const inputs = new Map(snapshot.provenance?.entries);
	const existing = new Map(
		state
			.observationsInTransaction(db, record.conversationId)
			.filter((row) => row.scope === record.scope)
			.map((row) => [row.observationId, row]),
	);
	for (const observation of snapshot.observations) {
		if (
			observation.text === "" &&
			snapshot.forgottenRefs?.includes(observation.id)
		)
			continue;
		const input = inputs.get(`observation:${observation.id}`) ?? {
			sources: [observation.id],
			complete: false,
		};
		const entry: ArchivedObservation = { observation, input };
		const previous = existing.get(observation.id);
		if (previous) {
			const old = memory.readRecordInTransaction(db, {
				recordId: previous.ref.id,
				revision: previous.ref.revision,
			});
			if (!old || old.content !== JSON.stringify(entry))
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
			content: JSON.stringify(entry),
		});
		state.saveObservationInTransaction(db, {
			conversationId: record.conversationId,
			scope: record.scope,
			observationId: observation.id,
			ref,
			input,
		});
	}
	state.refreshDependenciesInTransaction(
		db,
		record.conversationId,
		record.scope,
		record.sourceRefs,
	);
	// A compacted checkpoint still resolves its archived evidence through the same Memory port.
	const compacted = prepareCompaction(snapshot).checkpoint;
	return {
		...record,
		snapshot: {
			...compacted,
			observations: compacted.observations.map((o) => ({ ...o, text: "" })),
			memoryObservations: true,
		},
	};
}

export function resultInput(c: Conv, ticketId: string): InputContext {
	const s = c.runtime.snapshot();
	return combineInput(
		new Map(s.provenance?.entries).get(`attempt:${ticketId}`) ?? {
			sources: [],
			complete: false,
		},
	);
}
