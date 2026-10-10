import type { Database } from "bun:sqlite";
import type { RequestRow } from "../repository";
import { get } from "../repository";
import { additionalValidationParents } from "./control-policy";
export function createVoiceBinding(
	valid: (db: Database, id: string) => boolean,
	allowed: (db: Database, row: RequestRow) => boolean,
) {
	return function bindInTransaction(
		db: Database,
		voiceSubject: string,
		runSubject: string,
		deadline?: number,
		validation?: { validationRequestIds: string[] },
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
		const extra = additionalValidationParents(
			db,
			row.id,
			validation?.validationRequestIds ?? [],
			valid,
		);
		if (transcription || extra.length) {
			db.query("UPDATE inference_requests SET parents=? WHERE id=?").run(
				JSON.stringify([
					...(transcription ? [transcription.id] : []),
					...extra,
				]),
				row.id,
			);
			db.query(
				"UPDATE inference_requests SET parents=? WHERE subject=? AND purpose='tts'",
			).run(
				JSON.stringify([
					...(transcription ? [transcription.id] : []),
					row.id,
					...extra,
				]),
				voiceSubject,
			);
		}
		db.query(
			"UPDATE inference_requests SET subject=?,deadline=MIN(deadline,?) WHERE id=?",
		).run(runSubject, deadline ?? Number.MAX_SAFE_INTEGER, row.id);
	};
}
