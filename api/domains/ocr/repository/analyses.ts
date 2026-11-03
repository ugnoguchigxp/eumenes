import type { MediaAnalysisRow } from "../../../infrastructure/media-analysis";
import type { Database } from "bun:sqlite";
import type { AnalysisRecord } from "../../larm";
export type AnalysisRow = MediaAnalysisRow;
export const analysisRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM ocr_analyses WHERE id=?")
		.get(id) as AnalysisRow | null;
export const analysisRecord = (r: AnalysisRow) =>
	JSON.parse(r.record_json) as AnalysisRecord;
export function updateAnalysis(
	db: Database,
	r: AnalysisRow,
	change: Partial<AnalysisRecord>,
) {
	const v = { ...analysisRecord(r), ...change, updatedAt: Date.now() };
	db.query("UPDATE ocr_analyses SET record_json=? WHERE id=?").run(
		JSON.stringify(v),
		r.id,
	);
	return v;
}
export const analysisRows = (db: Database, id: string) =>
	db
		.query(
			"SELECT * FROM ocr_analyses WHERE source_id=? ORDER BY rowid DESC LIMIT 100",
		)
		.all(id) as AnalysisRow[];
