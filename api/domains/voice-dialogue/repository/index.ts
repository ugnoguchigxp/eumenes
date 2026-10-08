import type { Database } from "bun:sqlite";
import type { VoiceTurn } from "../contracts";
export const migration = `
CREATE TABLE voice_turns (utterance_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,text TEXT,run_id TEXT,error TEXT,revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX voice_turns_session ON voice_turns(session_id,generation,created_at);
`;
export const sequenceMigration = `
ALTER TABLE voice_turns ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX voice_turns_order ON voice_turns(session_id,generation,sequence) WHERE sequence > 0;
`;
export function get(db: Database, id: string): VoiceTurn | null {
	const row = db
		.query(
			"SELECT utterance_id,session_id,generation,sequence,status,text,run_id,error,revision FROM voice_turns WHERE utterance_id=?",
		)
		.get(id) as Record<string, unknown> | null;
	return row
		? {
				utteranceId: row.utterance_id as string,
				sessionId: row.session_id as string,
				generation: row.generation as number,
				sequence: row.sequence as number,
				status: row.status as VoiceTurn["status"],
				text: row.text as string | null,
				runId: row.run_id as string | null,
				error: row.error as string | null,
				revision: row.revision as number,
			}
		: null;
}
export function insert(db: Database, turn: VoiceTurn, now: string) {
	db.query(
		"INSERT INTO voice_turns (utterance_id,session_id,generation,sequence,status,text,run_id,error,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		turn.utteranceId,
		turn.sessionId,
		turn.generation,
		turn.sequence,
		turn.status,
		turn.text,
		turn.runId,
		turn.error,
		turn.revision,
		now,
		now,
	);
}
export function lastSequence(
	db: Database,
	sessionId: string,
	generation: number,
) {
	const row = db
		.query(
			"SELECT COALESCE(MAX(sequence),0) AS sequence FROM voice_turns WHERE session_id=? AND generation=?",
		)
		.get(sessionId, generation) as { sequence: number };
	return row.sequence;
}
export function update(
	db: Database,
	id: string,
	expected: number,
	status: VoiceTurn["status"],
	now: string,
	patch: { text?: string; runId?: string; error?: string } = {},
): boolean {
	return (
		db
			.query(
				"UPDATE voice_turns SET status=?,text=COALESCE(?,text),run_id=COALESCE(?,run_id),error=COALESCE(?,error),revision=revision+1,updated_at=? WHERE utterance_id=? AND revision=? AND status NOT IN ('cancelled','failed','interrupted','played','completed')",
			)
			.run(
				status,
				patch.text ?? null,
				patch.runId ?? null,
				patch.error ?? null,
				now,
				id,
				expected,
			).changes === 1
	);
}
export function interrupt(db: Database, now: string) {
	db.query(
		"UPDATE voice_turns SET status='interrupted',error='backend_restarted',revision=revision+1,updated_at=? WHERE status IN ('recognizing','responding','synthesizing','ready')",
	).run(now);
}
export function activeIds(
	db: Database,
	sessionId: string,
	generation: number,
): string[] {
	return (
		db
			.query(
				"SELECT utterance_id FROM voice_turns WHERE session_id=? AND generation=? AND status IN ('recognizing','responding','synthesizing','ready')",
			)
			.all(sessionId, generation) as { utterance_id: string }[]
	).map((x) => x.utterance_id);
}
export function activeRunIds(db: Database): string[] {
	return (
		db
			.query(
				"SELECT run_id FROM voice_turns WHERE run_id IS NOT NULL AND status IN ('recognizing','responding','synthesizing','ready')",
			)
			.all() as Array<{ run_id: string }>
	).map((row) => row.run_id);
}
