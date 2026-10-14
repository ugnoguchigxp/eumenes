import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { readBounded } from "../../../infrastructure/bounded-read";
import type { Prepared } from "../../capabilities";
import type { ChatImage } from "../../inference";
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
export async function imageForInput(
	bytes: Uint8Array,
	timestamp: number | null,
	signal: AbortSignal,
): Promise<ChatImage> {
	let source = bytes;
	if (timestamp !== null) {
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-hide_banner",
				"-loglevel",
				"info",
				"-i",
				"pipe:0",
				"-vf",
				`select=gte(t\\,${timestamp}),showinfo`,
				"-frames:v",
				"1",
				"-f",
				"image2pipe",
				"-vcodec",
				"png",
				"pipe:1",
			],
			{ stdin: bytes, stdout: "pipe", stderr: "pipe", signal },
		);
		let output: Uint8Array;
		let diagnostics: Uint8Array;
		try {
			[output, diagnostics] = await Promise.all([
				readBounded(proc.stdout, {
					limit: 16 * 1024 * 1024,
					tooLarge: "ocr_correction_frame_too_large",
					missing: "ocr_correction_frame_unavailable",
					signal,
				}),
				readBounded(proc.stderr, {
					limit: 128 * 1024,
					tooLarge: "ocr_correction_frame_unavailable",
					missing: "ocr_correction_frame_unavailable",
					signal,
				}),
			]);
		} catch (error) {
			proc.kill();
			throw error;
		}
		const times = [
			...new TextDecoder()
				.decode(diagnostics)
				.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g),
		].map((m) => Number(m[1]));
		const actual = times.at(-1);
		if (
			(await proc.exited) !== 0 ||
			!output.length ||
			actual === undefined ||
			Math.abs(actual - timestamp) > 0.25
		)
			throw new Error("ocr_correction_frame_unavailable");
		source = output;
	}
	if (signal.aborted) throw new Error("cancelled");
	const converted = await sharp(source, {
		failOn: "error",
		limitInputPixels: 64_000_000,
	})
		.rotate()
		.flatten({ background: "#ffffff" })
		.png()
		.toBuffer();
	const meta = await sharp(converted).metadata();
	if (!meta.width || !meta.height)
		throw new Error("ocr_correction_image_invalid");
	return {
		mime: "image/png",
		bytes: new Uint8Array(converted),
		width: meta.width,
		height: meta.height,
	};
}
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
