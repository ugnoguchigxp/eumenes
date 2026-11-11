import type { Database } from "bun:sqlite";
import type { MemoryService } from "../../memory";
import { isAgendaSnapshot } from "../contracts/agency-always-on";
import { agencyRecords } from "../repository/agency";
import { agencyObservations } from "../repository/agency-observations";
export function readAgencyRecords(
	db: Database,
	memory?: Pick<MemoryService, "referenceInputs">,
) {
	return agencyRecords(db).map((record) => {
		// The agenda keeps no archived observations: its checkpoint holds references, never the words.
		if (isAgendaSnapshot(record.snapshot)) return record;
		const snap = record.snapshot as import("eumenes-agency").AgencySnapshot & {
			memoryObservations?: boolean;
		};
		if (!snap.memoryObservations) return record;
		if (!memory) throw new Error("agency_memory_unavailable");
		const rows = agencyObservations(db, record.conversationId).filter(
			(row) => row.scope === record.scope,
		);
		const observations = snap.observations.map((observation) => {
			if (snap.forgottenRefs?.includes(observation.id)) return observation;
			const row = rows.find((row) => row.observationId === observation.id);
			const found =
				row &&
				memory!.referenceInputs.readRecordInTransaction(db, {
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
}
