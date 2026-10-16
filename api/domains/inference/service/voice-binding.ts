import type { Database } from "bun:sqlite";
import type { RequestRow } from "../repository";
import { get } from "../repository";
export function createVoiceBinding(
	valid: (db: Database, id: string) => boolean,
	allowed: (db: Database, row: RequestRow) => boolean,
) {
	return function bindInTransaction(
		db: Database,
		voiceSubject: string,
		runSubject: string,
		deadline?: number,
		transcriptions: string[] = [],
	) {
		const transcription = db
			.query(
				"SELECT id FROM inference_requests WHERE subject=? AND purpose='asr'",
			)
			.get(voiceSubject) as { id: string } | null;
		if (transcription && !valid(db, transcription.id))
			throw new Error("permission_revoked");
		const row = db
			.query(
				"SELECT id,status FROM inference_requests WHERE subject=? AND purpose='llm'",
			)
			.get(voiceSubject) as { id: string; status: string } | null;
		if (!row || row.status !== "pending")
			throw new Error("invalid_voice_inference");
		const policy = get(db, row.id);
		if (!policy || !allowed(db, policy)) throw new Error("permission_revoked");
		if (
			transcriptions.length > 32 ||
			new Set(transcriptions).size !== transcriptions.length
		)
			throw new Error("invalid_voice_inference");
		for (const id of transcriptions) {
			const r = get(db, id);
			if (
				!r ||
				r.purpose !== "asr" ||
				r.status !== "accepted" ||
				!valid(db, id)
			)
				throw new Error("permission_revoked");
		}
		const parents = [
			...new Set([
				...(transcription ? [transcription.id] : []),
				...transcriptions,
			]),
		];
		if (parents.length) {
			db.query("UPDATE inference_requests SET parents=? WHERE id=?").run(
				JSON.stringify(parents),
				row.id,
			);
			db.query(
				"UPDATE inference_requests SET parents=? WHERE subject=? AND purpose='tts'",
			).run(JSON.stringify([...parents, row.id]), voiceSubject);
		}
		db.query(
			"UPDATE inference_requests SET subject=?,deadline=MIN(deadline,?) WHERE id=?",
		).run(runSubject, deadline ?? Number.MAX_SAFE_INTEGER, row.id);
	};
}
