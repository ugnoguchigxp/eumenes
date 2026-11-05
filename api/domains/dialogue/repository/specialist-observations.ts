import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

export const specialistObservationsMigration: Migration = {
	id: "dialogue/0035-specialist-observations",
	after: ["dialogue/0034-agency-dispatch-clock"],
	sql: `CREATE TABLE dialogue_specialist_observations (
 run_id TEXT PRIMARY KEY REFERENCES dialogue_runs(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL UNIQUE, source_run_id TEXT NOT NULL,
 event_json TEXT NOT NULL
);`,
};
export const observation = (db: Database, runId: string) =>
	db
		.query<
			{ event_id: string; source_run_id: string; event_json: string },
			[string]
		>("SELECT * FROM dialogue_specialist_observations WHERE run_id=?")
		.get(runId);
/** The accepted explanation of this session's exact child result, never a manual turn or a question. */
export const childReportRun = (
	db: Database,
	sessionId: string,
	childId: string,
) =>
	db
		.query<{ id: string }, [string, string]>(
			`SELECT r.id FROM dialogue_specialist_observations o JOIN dialogue_runs r ON r.id=o.run_id
WHERE r.specialist_session_id=? AND r.source_kind='notice' AND r.status='completed' AND r.answer_message_id IS NOT NULL
AND json_extract(o.event_json,'$.id')=? AND json_extract(o.event_json,'$.status') NOT IN ('running','waiting_user')
ORDER BY r.seq DESC LIMIT 1`,
		)
		.get(sessionId, childId)?.id ?? null;
export function forgetObservations(
	db: Database,
	messageIds: readonly string[],
) {
	for (const id of messageIds)
		db.query(
			"DELETE FROM dialogue_specialist_observations WHERE source_run_id IN (SELECT id FROM dialogue_runs WHERE input_message_id=?)",
		).run(id);
}

/** Every child observation of a work depends on all of that session's contributing inputs. */
export function forgetSessionObservations(db: Database, sessionId: string) {
	db.query(
		"DELETE FROM dialogue_specialist_observations WHERE run_id IN (SELECT id FROM dialogue_runs WHERE specialist_session_id=?)",
	).run(sessionId);
}
