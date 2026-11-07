import type { Database } from "bun:sqlite";
import type { InputContext } from "eumenes-agency";
import type { SourceRef } from "eumenes-memory";

export const agencyObservationsMigration = `
CREATE TABLE dialogue_agency_observations (
 conversation_id TEXT NOT NULL, scope TEXT NOT NULL, observation_id TEXT NOT NULL,
 record_ref TEXT NOT NULL, input_json TEXT NOT NULL,
 PRIMARY KEY(conversation_id, scope, observation_id)
);
CREATE TABLE dialogue_agency_dependents (
 conversation_id TEXT NOT NULL, external_id TEXT PRIMARY KEY
);`;
export type AgencyObservationRef = {
	conversationId: string;
	scope: string;
	observationId: string;
	ref: SourceRef;
	input: InputContext;
};
export function agencyObservations(
	db: Database,
	conversationId?: string,
): AgencyObservationRef[] {
	// Legacy fixture stores can intentionally contain only the old schema.
	if (
		!db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name='dialogue_agency_observations'",
			)
			.get()
	)
		return [];
	return (
		db
			.query(
				`SELECT conversation_id,scope,observation_id,record_ref,input_json FROM dialogue_agency_observations${conversationId === undefined ? "" : " WHERE conversation_id=?"}`,
			)
			.all(...(conversationId === undefined ? [] : [conversationId])) as {
			conversation_id: string;
			scope: string;
			observation_id: string;
			record_ref: string;
			input_json: string;
		}[]
	).map((row) => ({
		conversationId: row.conversation_id,
		scope: row.scope,
		observationId: row.observation_id,
		ref: JSON.parse(row.record_ref) as SourceRef,
		input: JSON.parse(row.input_json) as InputContext,
	}));
}
export function saveAgencyObservation(db: Database, row: AgencyObservationRef) {
	db.query(
		"INSERT INTO dialogue_agency_observations VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,scope,observation_id) DO UPDATE SET record_ref=excluded.record_ref,input_json=excluded.input_json",
	).run(
		row.conversationId,
		row.scope,
		row.observationId,
		JSON.stringify(row.ref),
		JSON.stringify(row.input),
	);
}
export function deleteAgencyObservation(
	db: Database,
	row: AgencyObservationRef,
) {
	db.query(
		"DELETE FROM dialogue_agency_observations WHERE conversation_id=? AND scope=? AND observation_id=?",
	).run(row.conversationId, row.scope, row.observationId);
}
export function agencyDependents(
	db: Database,
	conversationId: string,
): string[] {
	return (
		db
			.query(
				"SELECT external_id FROM dialogue_agency_dependents WHERE conversation_id=?",
			)
			.all(conversationId) as { external_id: string }[]
	).map((row) => row.external_id);
}
export function replaceAgencyDependents(
	db: Database,
	conversationId: string,
	ids: readonly string[],
) {
	db.query(
		"DELETE FROM dialogue_agency_dependents WHERE conversation_id=?",
	).run(conversationId);
	for (const id of ids)
		db.query("INSERT INTO dialogue_agency_dependents VALUES(?,?)").run(
			conversationId,
			id,
		);
}
