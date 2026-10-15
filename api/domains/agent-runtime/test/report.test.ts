import { test, expect } from "bun:test";
import { verifyReport, parentProjection } from "../service/verify-report";
import type { Source } from "../../tool-runtime";
import { evidenceExcerpts } from "../service/evidence-excerpts";
import { ValidationFailure } from "../../../infrastructure/validation-log";
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

test("model-selected excerpt references become exact canonical quotes without copying or normalizing source text", () => {
	const body =
		"鎌倉\n\n10月10日(土)\n晴れ\n25℃\n17℃\n" +
		"料金は税込 1,000 円。\n".repeat(30);
	const observed = { ...source, body };
	const excerpts = evidenceExcerpts(body);
	const raw = {
		...input,
		claims: [
			{
				text: "鎌倉は晴れ、最高25℃。",
				evidence: [
					{ sourceId: source.sourceId, excerptId: excerpts[0]!.excerptId },
				],
			},
		],
	};
	const report = verifyReport(raw, [observed], false);
	expect(report.claims[0]!.evidence[0]).toEqual({
		sourceId: source.sourceId,
		quote: excerpts[0]!.quote,
	});
	expect(body.includes(report.claims[0]!.evidence[0]!.quote)).toBe(true);
	expect(JSON.stringify(report)).not.toContain("excerptId");
	expect(JSON.stringify(parentProjection(report))).not.toContain("quote");
	// Joining the page's separate cells into a fabricated sentence remains forbidden.
	expect(() =>
		verifyReport(
			{
				...raw,
				claims: [
					{
						text: "晴れ",
						evidence: [
							{ sourceId: source.sourceId, quote: "10月10日(土) 晴れ 25℃ 17℃" },
						],
					},
				],
			},
			[observed],
			false,
		),
	).toThrow("invalid_evidence");
});

test("references cannot cite missing sources, unseen text, another source's excerpt, or override canonical quotes", () => {
	const report = (sourceId: string, excerptId: string, extra = {}) => ({
		...input,
		claims: [{ text: "晴れ", evidence: [{ sourceId, excerptId, ...extra }] }],
	});
	for (const raw of [
		report("missing", "e0"),
		report(source.sourceId, "e99"),
		report(source.sourceId, "e1"),
		report(source.sourceId, "e0", { quote: "fabricated" }),
	])
		expect(() => verifyReport(raw, [source], false)).toThrow();
	const unseen = { ...source, body: "a".repeat(600) };
	expect(() =>
		verifyReport(
			report(source.sourceId, "e1"),
			[{ ...unseen, body: unseen.body.slice(0, 300), truncated: true }],
			false,
		),
	).toThrow("invalid_evidence");
	try {
		verifyReport(report(source.sourceId, "e99"), [source], false);
	} catch (error) {
		expect(error).toBeInstanceOf(ValidationFailure);
		expect((error as ValidationFailure).issues).toEqual([
			{
				validationPath: "report.claims.0.evidence.0.excerptId",
				validationCode: "unknown_excerpt",
			},
		]);
	}
	expect(
		verifyReport(
			report(source.sourceId, "e0"),
			[{ ...source, basis: "snippet" }],
			false,
		).coverage,
	).toBe("partial");
});

test("excerpt boundaries preserve Unicode and bound every quote to the public report contract", () => {
	for (const body of [
		"😀".repeat(2400),
		"a".repeat(299) + "😀" + "b".repeat(600),
		" \n".repeat(400),
		"a".repeat(101) + "。" + "b".repeat(800),
	]) {
		for (const excerpt of evidenceExcerpts(body)) {
			expect(excerpt.quote.length).toBeLessThanOrEqual(300);
			expect(body.includes(excerpt.quote)).toBe(true);
			expect(excerpt.quote).not.toMatch(/[\uD800-\uDFFF]/u);
		}
	}
});
test("a world claim is cited by its excerpt and projected as a reference without text, title or URL", () => {
	const claim: Source = {
		kind: "world_claim",
		sourceId: "11111111-1111-4111-8111-111111111111",
		viewId: "22222222-2222-4222-8222-222222222222",
		viewDigest: "digest",
		sourceRef: "claim-1",
		sourceRevision: "3",
		scopeRef: "scope",
		title: "INJECTION_TITLE",
		basis: "world",
		origin: "model_hypothesis",
		fetchedAt: new Date().toISOString(),
		truncated: false,
		body: "対象: 経費精算システム / 項目: owner / 値: 経理部\nINJECTION_BODY",
	};
	const excerpt = evidenceExcerpts(claim.body)[0]!;
	const report = verifyReport(
		{
			version: 2,
			outcome: "answered",
			summary: "経理部が担当と記録されています。",
			claims: [
				{
					text: "経理部が担当",
					evidence: [
						{
							sourceId: claim.sourceId,
							viewId: claim.viewId,
							excerptId: excerpt.excerptId,
						},
					],
				},
			],
			limitations: [],
			exploration: ["確認した操作2件。"],
		},
		[claim],
		false,
		true,
	);
	// The parent never receives a quote for a world claim.
	expect(report.claims[0]!.evidence[0]!.quote).toBe("");
	const projected = parentProjection(report);
	expect(projected.sources).toEqual([
		{
			sourceId: claim.sourceId,
			kind: "world_claim",
			origin: "model_hypothesis",
		},
	]);
	expect(JSON.stringify(projected)).not.toContain("INJECTION");
	expect(JSON.stringify(projected)).not.toContain("url");
	// The conversation model never sees World ids or revisions.
	expect(JSON.stringify(projected)).not.toContain("claim-1");
	expect(JSON.stringify(projected)).not.toContain("claimId");
	expect(JSON.stringify(projected)).not.toContain("revision");
});
