import type { MediaAnalysisStorage } from "../../../infrastructure/media-analysis";
import type { AnalysisRecord, AnalysisCreate } from "../../larm";
import { owned, record, row } from "../repository";
import {
	analysisRow,
	analysisRows,
	analysisRecord,
	updateAnalysis,
	type AnalysisRow,
} from "../repository/analyses";
import { digest, frame, valid } from "./analysis-source";
/** The owner keeps authorization, source interpretation and every SQL operation. */
export function analysisStorage(): MediaAnalysisStorage<
	AnalysisRecord,
	AnalysisCreate
> {
	return {
		scope: "ocr",
		row: analysisRow,
		rows: analysisRows,
		record: analysisRecord,
		update: updateAnalysis,
		valid,
		allRows: (db, id) =>
			db
				.query("SELECT * FROM ocr_analyses WHERE source_id=?")
				.all(id) as AnalysisRow[],
		pending: (db) =>
			db
				.query(
					"SELECT * FROM ocr_analyses WHERE connection_id IS NOT NULL AND (json_extract(record_json,'$.releaseConfirmed') IS NULL OR json_extract(record_json,'$.releaseConfirmed') = 0 OR json_extract(record_json,'$.stopObservation.status') = 'observing')",
				)
				.all() as AnalysisRow[],
		source(db, owner, id) {
			const src = owned(db, id, owner);
			return {
				bytes: src.bytes,
				conversationId: src.conversation_id,
				get revision() {
					return record(src).revision;
				},
				get digest() {
					return digest(src);
				},
				frame: (index) => frame(src, index),
			};
		},
		sourceBytes: (db, id) => row(db, id)!.bytes,
		insert(db, r, owner, input) {
			db.query(
				"INSERT INTO ocr_analyses(id,source_id,owner,conversation_id,frame_key,record_json,input_json) VALUES(?,?,?,?,?,?,?)",
			).run(
				r.id,
				r.sourceId,
				owner,
				input.conversationId,
				input.frameIndex ?? -1,
				JSON.stringify(r),
				JSON.stringify(input),
			);
		},
		setJob: (db, id, jobId) => {
			db.query("UPDATE ocr_analyses SET job_id=? WHERE id=?").run(jobId, id);
		},
		setConnection: (db, id, connectionId) => {
			db.query("UPDATE ocr_analyses SET connection_id=? WHERE id=?").run(
				connectionId,
				id,
			);
		},
		deleteSource: (db, id) => {
			db.query("DELETE FROM ocr_analyses WHERE source_id=?").run(id);
		},
	};
}
