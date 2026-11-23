import { z } from "zod";

const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/);
export const webEvidenceContract = z.strictObject({
	rowsKey: field,
	refsField: field.optional(),
	urlField: field.optional(),
	minSources: z.number().int().min(1).max(2).default(1),
});
export type WebEvidenceContract = z.infer<typeof webEvidenceContract>;
export const webCitations = z
	.array(
		z.strictObject({
			pointer: z.string().max(200),
			refs: z.array(z.string().min(1).max(300)).min(1).max(32),
		}),
	)
	.max(1000);
export type WebEvidenceSource = {
	url: string;
	fetchedAt: string;
	truncated: boolean;
	ranges: Array<{ ref: string; start: number; end: number; digest: string }>;
};

export function webRecordModelSchema(
	output: z.ZodType,
	contract: WebEvidenceContract,
) {
	const rows =
		output instanceof z.ZodObject ? output.shape[contract.rowsKey] : null;
	if (
		!(output instanceof z.ZodObject) ||
		!(rows instanceof z.ZodArray) ||
		!(rows.element instanceof z.ZodObject)
	)
		throw new Error("workflow_web_evidence_schema_invalid");
	const row = rows.element;
	const omitted = Object.fromEntries(
		[contract.refsField, contract.urlField]
			.filter((key): key is string => !!key)
			.map((key) => [key, true as const]),
	);
	if (Object.keys(omitted).some((key) => !Object.hasOwn(row.shape, key)))
		throw new Error("workflow_web_evidence_schema_invalid");
	const shape = Object.fromEntries(
		Object.entries(row.shape).filter(([key]) => !Object.hasOwn(omitted, key)),
	) as Record<string, z.ZodType>;
	return output.extend({ [contract.rowsKey]: z.array(z.strictObject(shape)) });
}

/** Values are model judgments; provenance is resolved exclusively from this acquisition. */
export function verifiedWebRecords(
	data: unknown,
	citations: z.infer<typeof webCitations>,
	sources: WebEvidenceSource[],
	contract: WebEvidenceContract,
	output: z.ZodType,
) {
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new Error("workflow_web_evidence_invalid");
	const value = structuredClone(data) as Record<string, unknown>;
	const rows = value[contract.rowsKey];
	if (!Array.isArray(rows)) throw new Error("workflow_web_evidence_invalid");
	const ranges = new Map(
		sources.flatMap((source) =>
			source.ranges.map(
				(range) =>
					[
						range.ref,
						{ ...range, url: source.url, fetchedAt: source.fetchedAt },
					] as const,
			),
		),
	);
	const byPointer = new Map(citations.map((item) => [item.pointer, item.refs]));
	if (byPointer.size !== citations.length || citations.length !== rows.length)
		throw new Error("workflow_web_evidence_invalid");
	let partial = rows.length === 0 || sources.some((source) => source.truncated);
	const evidence = rows.map((row: unknown, index: number) => {
		if (!row || typeof row !== "object" || Array.isArray(row))
			throw new Error("workflow_web_evidence_invalid");
		const pointer = `/${contract.rowsKey}/${index}`;
		const refs = byPointer.get(pointer);
		if (!refs?.length || new Set(refs).size !== refs.length)
			throw new Error("workflow_web_evidence_invalid");
		const resolved = refs.map((ref) => {
			const range = ranges.get(ref);
			if (!range) throw new Error("workflow_web_evidence_invalid");
			return range;
		});
		if (new Set(resolved.map((range) => range.url)).size < contract.minSources)
			partial = true;
		if (contract.refsField)
			(row as Record<string, unknown>)[contract.refsField] = refs;
		if (contract.urlField)
			(row as Record<string, unknown>)[contract.urlField] = resolved[0]!.url;
		return { pointer, sources: resolved };
	});
	return {
		data: output.parse(value),
		provenance: {
			coverage: partial ? ("partial" as const) : ("complete" as const),
			evidence,
		},
	};
}
