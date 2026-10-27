import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AnalysisRecord } from "../../larm";
import { record, row, type Row } from "../repository";
import { analysisRecord, type AnalysisRow } from "../repository/analyses";
export const active = (v: AnalysisRecord) =>
	["queued", "starting", "running", "cancelling"].includes(v.state);
/** The capture's LARM save state changes beside the source, so it is left out of the source's digest. */
function sourceJson(json: string) {
	const { captureSave, ...source } = JSON.parse(json) as Record<
		string,
		unknown
	>;
	return captureSave === undefined ? json : JSON.stringify(source);
}
export const digest = (r: Row) =>
	createHash("sha256")
		.update(r.bytes)
		.update(sourceJson(r.record_json))
		.digest("hex");
export function frame(r: Row, index?: number) {
	const v = record(r);
	if (
		r.mime.startsWith("image/") &&
		["completed", "failed", "cancelled"].includes(v.state) &&
		index === undefined
	)
		return null;
	if (
		v.state !== "completed" ||
		v.result?.kind !== "video" ||
		index === undefined ||
		!v.result.frames[index]
	)
		throw new Error("analysis_not_ready");
	return v.result.frames[index]!.timestampSeconds;
}

export const valid = (db: Database, r: AnalysisRow) => {
	const src = row(db, r.source_id),
		v = analysisRecord(r);
	return (
		!!src &&
		src.owner === r.owner &&
		src.conversation_id === r.conversation_id &&
		record(src).revision === v.sourceRevision &&
		digest(src) === v.sourceDigest
	);
};
