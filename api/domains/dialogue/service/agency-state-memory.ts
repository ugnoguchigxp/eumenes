import type { Database } from "bun:sqlite";
import type { MemoryService } from "../../memory";
import { isAlwaysOnSnapshot } from "../contracts/agency-always-on";
import { agencyRecords, type AgencyRecord } from "../repository/agency";
import { agencyObservations } from "../repository/agency-observations";
export function readAgencyRecords(
	db: Database,
	memory?: Pick<MemoryService, "referenceInputs">,
) {
	return agencyRecords(db).map((record) => {
		const alwaysOn = isAlwaysOnSnapshot(record.snapshot)
			? record.snapshot
			: null;
		const snap = (alwaysOn?.agent ??
			record.snapshot) as import("eumenes-agency").AgencySnapshot & {
			memoryObservations?: boolean;
		};
		if (!(alwaysOn?.memoryObservations ?? snap.memoryObservations))
			return record;
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
		return {
			...record,
			snapshot: alwaysOn
				? { ...alwaysOn, agent: { ...alwaysOn.agent, observations } }
				: { ...snap, observations },
		};
	});
}

/** An unreadable scope never blocks other conversations during recovery. */
export function canRestoreAlwaysOnRecord(
	db: Database,
	record: AgencyRecord,
	memory?: Pick<MemoryService, "referenceInputs">,
): boolean {
	if (!isAlwaysOnSnapshot(record.snapshot)) return false;
	const idle = record.idle as { anchor?: unknown; intervalMs?: unknown } | null;
	if (
		typeof idle?.anchor !== "number" ||
		!Number.isFinite(idle.anchor) ||
		typeof idle.intervalMs !== "number" ||
		!Number.isFinite(idle.intervalMs) ||
		idle.intervalMs <= 0
	)
		return false;
	if (!record.snapshot.memoryObservations) return false;
	if (!memory) return false;
	const rows = agencyObservations(db, record.conversationId).filter(
		(row) => row.scope === record.scope,
	);
	try {
		return record.snapshot.agent.observations.every((o) => {
			const row = rows.find((r) => r.observationId === o.id);
			if (!row) return false;
			const found = memory.referenceInputs.readRecordInTransaction(db, {
				recordId: row.ref.id,
				revision: row.ref.revision,
			});
			if (!found || found.ref.digest !== row.ref.digest) return false;
			const entry = JSON.parse(found.content) as {
				observation?: { id?: string };
			};
			return entry.observation?.id === o.id;
		});
	} catch {
		return false;
	}
}
