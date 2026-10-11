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
export type PreparedInput = {
	utteranceId: string;
	rawText: string;
	sources: string[];
	asrRequests: string[];
	languageRequest: string | null;
	readiness: "ready" | "waiting" | "uncertain";
};
export function readInput(db: Database, id: string): PreparedInput | null {
	const r = db
		.query("SELECT * FROM voice_input_preparations WHERE utterance_id=?")
		.get(id) as {
		utterance_id: string;
		raw_text: string;
		sources: string;
		asr_requests: string;
		language_request: string | null;
		readiness: PreparedInput["readiness"];
	} | null;
	return r
		? {
				utteranceId: r.utterance_id,
				rawText: r.raw_text,
				sources: JSON.parse(r.sources),
				asrRequests: JSON.parse(r.asr_requests),
				languageRequest: r.language_request,
				readiness: r.readiness,
			}
		: null;
}
export function saveInput(db: Database, input: PreparedInput) {
	db.query(
		"INSERT INTO voice_input_preparations VALUES (?,?,?,?,?,?) ON CONFLICT(utterance_id) DO UPDATE SET raw_text=excluded.raw_text,sources=excluded.sources,asr_requests=excluded.asr_requests,language_request=excluded.language_request,readiness=excluded.readiness",
	).run(
		input.utteranceId,
		input.rawText,
		JSON.stringify(input.sources),
		JSON.stringify(input.asrRequests),
		input.languageRequest,
		input.readiness,
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
					"SELECT v.utterance_id AS id FROM voice_turns v JOIN voice_input_preparations p ON p.utterance_id=v.utterance_id WHERE v.session_id=? AND v.generation=? AND v.sequence<? AND v.status IN ('awaiting_input','input_ready','draft') AND NOT EXISTS (SELECT 1 FROM voice_turns boundary WHERE boundary.session_id=v.session_id AND boundary.generation=v.generation AND boundary.sequence>v.sequence AND boundary.sequence<? AND (boundary.run_id IS NOT NULL OR boundary.status='responding')) ORDER BY v.sequence DESC LIMIT 1",
				)
				.get(sessionId, generation, sequence, sequence) as { id: string } | null
		)?.id ?? null
	);
}
