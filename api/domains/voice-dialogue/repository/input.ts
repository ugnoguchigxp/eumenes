import type { Database } from "bun:sqlite";
export const inputMigration = `
CREATE TABLE voice_input_preparations (
 utterance_id TEXT PRIMARY KEY REFERENCES voice_turns(utterance_id),
 raw_text TEXT NOT NULL,
 sources TEXT NOT NULL,
 asr_requests TEXT NOT NULL,
 language_request TEXT,
 readiness TEXT NOT NULL DEFAULT 'uncertain'
);
`;
/**
 * Frozen deployed SQL: inputs are ready as transcribed, without language or endpoint judgments.
 */
export const inputSimplificationMigration = `
ALTER TABLE voice_input_preparations DROP COLUMN language_request;
ALTER TABLE voice_input_preparations DROP COLUMN readiness;
UPDATE voice_turns SET status='interrupted',error=COALESCE(error,'input_superseded'),revision=revision+1 WHERE status IN ('awaiting_input','draft');
`;
/** The transcript lives only on the turn; keep this separate from the deployed simplification. */
export const inputTextDedupMigration = `
ALTER TABLE voice_input_preparations DROP COLUMN raw_text;
`;
export type PreparedInput = {
	utteranceId: string;
	sources: string[];
	asrRequests: string[];
};
export function readInput(db: Database, id: string): PreparedInput | null {
	const r = db
		.query("SELECT * FROM voice_input_preparations WHERE utterance_id=?")
		.get(id) as {
		utterance_id: string;
		sources: string;
		asr_requests: string;
	} | null;
	return r
		? {
				utteranceId: r.utterance_id,
				sources: JSON.parse(r.sources),
				asrRequests: JSON.parse(r.asr_requests),
			}
		: null;
}
export function saveInput(db: Database, input: PreparedInput) {
	db.query(
		"INSERT INTO voice_input_preparations (utterance_id,sources,asr_requests) VALUES (?,?,?) ON CONFLICT(utterance_id) DO UPDATE SET sources=excluded.sources,asr_requests=excluded.asr_requests",
	).run(
		input.utteranceId,
		JSON.stringify(input.sources),
		JSON.stringify(input.asrRequests),
	);
}
export function previousInputId(
	db: Database,
	sessionId: string,
	generation: number,
	sequence: number,
): string | null {
	return (
		(
			db
				.query(
					"SELECT v.utterance_id AS id FROM voice_turns v JOIN voice_input_preparations p ON p.utterance_id=v.utterance_id WHERE v.session_id=? AND v.generation=? AND v.sequence<? AND v.status='input_ready' AND NOT EXISTS (SELECT 1 FROM voice_turns boundary WHERE boundary.session_id=v.session_id AND boundary.generation=v.generation AND boundary.sequence>v.sequence AND boundary.sequence<? AND (boundary.run_id IS NOT NULL OR boundary.status='responding')) ORDER BY v.sequence DESC LIMIT 1",
				)
				.get(sessionId, generation, sequence, sequence) as { id: string } | null
		)?.id ?? null
	);
}
