import type { Database } from "bun:sqlite";
import type { CorrectionRecord, OcrRecord } from "../contracts";

/** A read of the owner's own tables for the `document` resource kind; nothing is copied elsewhere. */
export type DocumentRow =
	| { type: "input"; record: OcrRecord }
	| { type: "correction"; record: CorrectionRecord; source: OcrRecord };

type CorrectionJoin = { record_json: string; source_json: string };

const input = (json: string): DocumentRow => ({
	type: "input",
	record: JSON.parse(json) as OcrRecord,
});
const correction = (row: CorrectionJoin): DocumentRow => ({
	type: "correction",
	record: JSON.parse(row.record_json) as CorrectionRecord,
	source: JSON.parse(row.source_json) as OcrRecord,
});

const CORRECTION_SELECT =
	"SELECT c.record_json AS record_json, i.record_json AS source_json FROM ocr_corrections c JOIN ocr_inputs i ON i.id=c.source_id";

/** The input with this id, else the correction with this id. */
export function documentById(db: Database, id: string): DocumentRow | null {
	const source = db
		.query("SELECT record_json FROM ocr_inputs WHERE id=?")
		.get(id) as { record_json: string } | null;
	if (source) return input(source.record_json);
	const corrected = db
		.query(`${CORRECTION_SELECT} WHERE c.id=?`)
		.get(id) as CorrectionJoin | null;
	return corrected ? correction(corrected) : null;
}

/** Every input and correction, newest rows first within each table. */
export function allDocuments(db: Database): DocumentRow[] {
	const inputs = db
		.query("SELECT record_json FROM ocr_inputs ORDER BY rowid DESC")
		.all() as Array<{ record_json: string }>;
	const corrections = db
		.query(`${CORRECTION_SELECT} ORDER BY c.rowid DESC`)
		.all() as CorrectionJoin[];
	return [
		...inputs.map((row) => input(row.record_json)),
		...corrections.map(correction),
	];
}
