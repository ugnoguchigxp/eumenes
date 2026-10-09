import { test, expect } from "bun:test";
import { verifyReport, parentProjection } from "../service/verify-report";
import type { Source } from "../../tool-runtime";
const source: Source = {
	sourceId: "source",
	url: "https://example.com",
	title: "INJECTION_TITLE",
	body: "東京は晴れ。\nINJECTION_BODY",
	basis: "page",
	fetchedAt: new Date().toISOString(),
	truncated: false,
};
const input = {
	summary: "東京は晴れ。",
	claims: [
		{
			text: "東京は晴れ。",
			evidence: [{ sourceId: "source", quote: "東京は晴れ。" }],
		},
	],
	limitations: [],
};
test("parent receives summary and citation metadata; neither raw text, quotes nor titles cross boundary", () => {
	const report = verifyReport(input, [source], false);
	const projection = JSON.stringify(parentProjection(report));
	expect(projection).toContain("東京は晴れ。");
	expect(projection).not.toContain("INJECTION");
	expect(projection).not.toContain('"quote"');
	expect(report.verification).toBe("evidence_linked");
});
test("unseen source and fabricated quote are refused; snippet and incomplete acquisition are partial", () => {
	expect(() => verifyReport(input, [], false)).toThrow("invalid_evidence");
	expect(() =>
		verifyReport(
			{
				...input,
				claims: [
					{
						text: "晴れ",
						evidence: [{ sourceId: "source", quote: "存在しない" }],
					},
				],
			},
			[source],
			false,
		),
	).toThrow("invalid_evidence");
	expect(
		verifyReport(input, [{ ...source, basis: "snippet" }], false).coverage,
	).toBe("partial");
	expect(verifyReport(input, [source], true).coverage).toBe("partial");
	expect(() => verifyReport({ ...input, claims: [] }, [source], false)).toThrow(
		"invalid_report",
	);
});
