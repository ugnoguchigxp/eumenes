import { expect, test } from "bun:test";
import { z } from "zod";
import { verifiedWebRecords, webRecordModelSchema } from "..";

const output = z.strictObject({
	rows: z.array(
		z.strictObject({
			title: z.string(),
			evidence: z.array(z.string()),
			source: z.string(),
		}),
	),
});
const contract = {
	rowsKey: "rows",
	refsField: "evidence",
	urlField: "source",
	minSources: 1,
};
const source = {
	url: "https://example.com/page",
	fetchedAt: "2026-11-23T00:00:00Z",
	truncated: false,
	ranges: [{ ref: "issued-range", start: 0, end: 8, digest: "a".repeat(64) }],
};
const data = { rows: [{ title: "取得した値" }] };
const citations = [{ pointer: "/rows/0", refs: ["issued-range"] }];

test("the model returns values; the host fills URL and evidence from the acquired range", () => {
	expect(webRecordModelSchema(output, contract).safeParse(data).success).toBe(
		true,
	);
	expect(
		webRecordModelSchema(output, contract).safeParse({
			rows: [{ ...data.rows[0], source: "https://fake.invalid/" }],
		}).success,
	).toBe(false);
	const result = verifiedWebRecords(
		data,
		citations,
		[source],
		contract,
		output,
	);
	expect(result.data).toEqual({
		rows: [
			{ title: "取得した値", evidence: ["issued-range"], source: source.url },
		],
	});
	expect(result.provenance).toMatchObject({
		coverage: "complete",
		evidence: [
			{
				pointer: "/rows/0",
				sources: [
					{
						ref: "issued-range",
						url: source.url,
						digest: source.ranges[0]!.digest,
					},
				],
			},
		],
	});
});
test("unknown, duplicate, unrelated and missing citations never validate a row", () => {
	for (const invalid of [
		[],
		[{ pointer: "/rows/0", refs: ["not-issued"] }],
		[{ pointer: "/rows/1", refs: ["issued-range"] }],
		[...citations, ...citations],
		[{ pointer: "/rows/0", refs: ["issued-range", "issued-range"] }],
	]) {
		expect(() =>
			verifiedWebRecords(data, invalid, [source], contract, output),
		).toThrow("workflow_web_evidence_invalid");
	}
});
test("a missing comparison source and truncated acquisition remain partial", () => {
	expect(
		verifiedWebRecords(
			data,
			citations,
			[source],
			{ ...contract, minSources: 2 },
			output,
		).provenance.coverage,
	).toBe("partial");
	expect(
		verifiedWebRecords(
			data,
			citations,
			[{ ...source, truncated: true }],
			contract,
			output,
		).provenance.coverage,
	).toBe("partial");
});
test("an empty result without row evidence does not claim complete acquisition", () => {
	expect(
		verifiedWebRecords({ rows: [] }, [], [source], contract, output).provenance
			.coverage,
	).toBe("partial");
});
test("distinct acquired pages count as sources, while two ranges from one page do not", () => {
	const other = {
		...source,
		url: "https://example.com/other",
		ranges: [{ ...source.ranges[0]!, ref: "other-range" }],
	};
	const both = [{ pointer: "/rows/0", refs: ["issued-range", "other-range"] }];
	expect(
		verifiedWebRecords(
			data,
			both,
			[source, other],
			{ ...contract, minSources: 2 },
			output,
		).provenance.coverage,
	).toBe("complete");
	expect(
		verifiedWebRecords(
			data,
			both,
			[source, { ...other, url: source.url }],
			{ ...contract, minSources: 2 },
			output,
		).provenance.coverage,
	).toBe("partial");
});
