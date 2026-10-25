import type { Database } from "bun:sqlite";
import { qrRecord, type QrRecord } from "../contracts/qr";
export type QrRow = {
	id: string;
	source_id: string;
	owner: string;
	conversation_id: string;
	frame_key: number;
	source_revision: number;
	record_json: string;
	job_id: string | null;
};
export const qrRow = (db: Database, id: string) =>
	db.query("SELECT * FROM ocr_qr WHERE id=?").get(id) as QrRow | null;
export const parsedQr = (r: QrRow) => qrRecord.parse(JSON.parse(r.record_json));
export function latestQr(
	db: Database,
	sourceId: string,
	key: number,
	revision: number,
) {
	return db
		.query(
			"SELECT * FROM ocr_qr WHERE source_id=? AND frame_key=? AND source_revision=? ORDER BY rowid DESC LIMIT 1",
		)
		.get(sourceId, key, revision) as QrRow | null;
}
export function updateQr(db: Database, r: QrRow, change: Partial<QrRecord>) {
	const value = { ...parsedQr(r), ...change, updatedAt: Date.now() };
	db.query("UPDATE ocr_qr SET record_json=? WHERE id=?").run(
		JSON.stringify(value),
		r.id,
	);
	return value;
}
