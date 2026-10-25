import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Prepared } from "../../capabilities";
import {
	correctionRecord,
	type CorrectionRecord,
	type OcrResult,
} from "../contracts";
export const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type CorrectionRow = {
	id: string;
	source_id: string;
	owner: string;
	conversation_id: string;
	frame_key: number;
	source_revision: number;
	source_digest: string;
	record_json: string;
	bindings_json: string;
	job_id: string | null;
	inference_request_id: string | null;
};
export const correctionRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM ocr_corrections WHERE id=?")
		.get(id) as CorrectionRow | null;
export const parsed = (r: CorrectionRow) =>
	correctionRecord.parse(JSON.parse(r.record_json));
export function update(
	db: Database,
	r: CorrectionRow,
	change: Partial<CorrectionRecord>,
) {
	const value = { ...parsed(r), ...change, updatedAt: Date.now() };
	db.query("UPDATE ocr_corrections SET record_json=? WHERE id=?").run(
		JSON.stringify(value),
		r.id,
	);
	return value;
}
export function sourceFrame(result: OcrResult, frameIndex: number | undefined) {
	if (result.kind === "image") {
		if (frameIndex !== undefined) throw new Error("invalid_ocr_frame");
		return {
			key: -1,
			timestamp: null,
			width: result.width,
			height: result.height,
			text: result.text,
			lines: result.lines,
		};
	}
	if (frameIndex === undefined || !result.frames[frameIndex])
		throw new Error("invalid_ocr_frame");
	const frame = result.frames[frameIndex]!;
	return {
		key: frameIndex,
		timestamp: frame.timestampSeconds,
		width: result.video.width,
		height: result.video.height,
		text: frame.text,
		lines: frame.lines,
	};
}
export { imageForInput } from "../../../infrastructure/media-image";
export function guidance(prepared: Prepared) {
	const ids = [
		prepared.package.profileRevisionId,
		...(prepared.package.requiredSkillRevisionIds ?? []),
	];
	const text = ids.map(
		(id) => prepared.dependencies.find((d) => d.revisionId === id)?.body,
	);
	if (text.some((t) => !t?.trim())) throw new Error("required_context_missing");
	return text.join("\n\n");
}
