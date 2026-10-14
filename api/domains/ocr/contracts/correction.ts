import { z } from "zod";

const anchor = z.strictObject({
	lineIndexes: z.array(z.number().int().nonnegative().max(9999)).max(10000),
	region: z
		.tuple([
			z.number().nonnegative(),
			z.number().nonnegative(),
			z.number().positive(),
			z.number().positive(),
		])
		.optional(),
});
const evidence = anchor.refine((a) => a.lineIndexes.length > 0 || !!a.region);
const textBlock = z.strictObject({
	kind: z.literal("paragraph"),
	text: z.string().min(1).max(10000),
	evidence,
	uncertain: z.boolean(),
	uncertainty: z.string().max(500).optional(),
});
const cell = z.strictObject({
	row: z.number().int().nonnegative().max(199),
	column: z.number().int().nonnegative().max(49),
	rowSpan: z.number().int().positive().max(200).default(1),
	columnSpan: z.number().int().positive().max(50).default(1),
	text: z.string().max(10000),
	evidence,
	uncertain: z.boolean(),
	uncertainty: z.string().max(500).optional(),
});
const tableBlock = z.strictObject({
	kind: z.literal("table"),
	rows: z.number().int().positive().max(200),
	columns: z.number().int().positive().max(50),
	cells: z.array(cell).min(1).max(1000),
	evidence,
	uncertain: z.boolean(),
	uncertainty: z.string().max(500).optional(),
});
export const correctionResult = z.strictObject({
	blocks: z
		.array(z.discriminatedUnion("kind", [textBlock, tableBlock]))
		.min(1)
		.max(300),
	excludedLines: z
		.array(
			z.strictObject({
				index: z.number().int().nonnegative().max(9999),
				reason: z.string().min(1).max(500),
			}),
		)
		.max(10000),
});
export type CorrectionResult = z.infer<typeof correctionResult>;
export const correctionRecord = z.strictObject({
	id: z.uuid(),
	sourceId: z.uuid(),
	frameIndex: z.number().int().nonnegative().nullable(),
	sourceRevision: z.number().int().nonnegative(),
	sourceDigest: z.string().length(64),
	state: z.enum([
		"queued",
		"running",
		"cancelling",
		"cancelled",
		"completed",
		"failed",
	]),
	errorCode: z.string().nullable(),
	result: correctionResult.nullable(),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
});
export type CorrectionRecord = z.infer<typeof correctionRecord>;
export const correctionCreate = z.strictObject({
	requestId: z.uuid(),
	conversationId: z.string().min(1).max(120),
	expectedRevision: z.number().int().nonnegative(),
	frameIndex: z.number().int().nonnegative().max(59).optional(),
});

export function validateCorrection(
	result: CorrectionResult,
	lineCount: number,
	width: number,
	height: number,
) {
	const covered = new Set<number>();
	const check = (a: z.infer<typeof anchor>) => {
		for (const i of a.lineIndexes) {
			if (i >= lineCount) throw new Error("ocr_correction_invalid_evidence");
			covered.add(i);
		}
		if (a.region) {
			const [x, y, w, h] = a.region;
			if (x + w > width || y + h > height)
				throw new Error("ocr_correction_invalid_evidence");
		}
	};
	let characters = 0;
	for (const block of result.blocks) {
		check(block.evidence);
		if (block.uncertain && !block.uncertainty?.trim())
			throw new Error("ocr_correction_invalid_evidence");
		if (block.kind === "paragraph") characters += block.text.length;
		else {
			const occupied = new Set<string>();
			for (const cell of block.cells) {
				check(cell.evidence);
				if (cell.uncertain && !cell.uncertainty?.trim())
					throw new Error("ocr_correction_invalid_evidence");
				if (
					cell.row + cell.rowSpan > block.rows ||
					cell.column + cell.columnSpan > block.columns
				)
					throw new Error("ocr_correction_invalid_table");
				for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
					for (let c = cell.column; c < cell.column + cell.columnSpan; c++) {
						const key = `${r}:${c}`;
						if (occupied.has(key))
							throw new Error("ocr_correction_invalid_table");
						occupied.add(key);
					}
				characters += cell.text.length;
			}
		}
	}
	if (characters > 100000) throw new Error("ocr_correction_too_large");
	for (const excluded of result.excludedLines) {
		if (excluded.index >= lineCount || covered.has(excluded.index))
			throw new Error("ocr_correction_invalid_evidence");
		covered.add(excluded.index);
	}
	if (covered.size !== lineCount)
		throw new Error("ocr_correction_unmapped_lines");
}

export function correctionPlainText(result: CorrectionResult) {
	return result.blocks
		.map((block) => {
			if (block.kind === "paragraph") return block.text;
			const grid = Array.from({ length: block.rows }, () =>
				Array<string>(block.columns).fill(""),
			);
			for (const cell of block.cells) grid[cell.row]![cell.column] = cell.text;
			return grid.map((row) => row.join("\t")).join("\n");
		})
		.join("\n\n");
}
