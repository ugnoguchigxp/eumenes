import { z } from "zod";

const line = z.number().int().nonnegative().max(199);
const source = z.string().min(1).max(10000);
const uncertainty = {
	uncertain: z.boolean(),
	uncertainty: z.string().max(500).optional(),
};
const part = z.strictObject({
	line,
	source: source.optional(),
	join: z.enum(["", " "]).optional(),
});
const parts = z.array(part).min(1).max(1000);
const paragraph = z.strictObject({
	kind: z.literal("paragraph"),
	parts,
	...uncertainty,
});
const cell = z.strictObject({
	row: z.number().int().nonnegative().max(199),
	column: z.number().int().nonnegative().max(49),
	rowSpan: z.number().int().positive().max(200).optional(),
	columnSpan: z.number().int().positive().max(50).optional(),
	parts,
	...uncertainty,
});
const table = z.strictObject({
	kind: z.literal("table"),
	rows: z.number().int().positive().max(200),
	columns: z.number().int().positive().max(50),
	cells: z.array(cell).min(1).max(1000),
	...uncertainty,
});

/** Internal one-shot edit contract. Public correction results remain unchanged. */
export const correctionPlan = z.strictObject({
	protectedSpans: z
		.array(
			z.union([
				z.strictObject({ line, text: source }),
				z.strictObject({ line, wholeLine: z.literal(true) }),
			]),
		)
		.max(1000),
	edits: z
		.array(
			z.union([
				z.strictObject({ line, before: source, after: z.string().max(10000) }),
				z.strictObject({
					line,
					wholeLine: z.literal(true),
					after: z.string().max(10000),
				}),
			]),
		)
		.max(1000),
	blocks: z
		.array(z.discriminatedUnion("kind", [paragraph, table]))
		.min(1)
		.max(300),
	excludedLines: z
		.array(z.strictObject({ index: line, reason: z.string().min(1).max(500) }))
		.max(200),
});
export type CorrectionPlan = z.infer<typeof correctionPlan>;
