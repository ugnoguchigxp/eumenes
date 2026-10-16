import { expect, test } from "bun:test";
import { EvidenceCatalog } from "../service/evidence-catalog";
import { evidenceExcerpts } from "../service/evidence-excerpts";
import { verifyReport } from "../service/verify-report";
import type { Source } from "../../tool-runtime";

test("structural Web views preserve table rows and heading/header references under the same material bound", () => {
	const body =
		"# 対象A\n## 2026-10-16\n|時間|値|単位|\n|---|---|---|\n|13:00|25.4|℃|\n```text\npublic source text\n```\n";
	const source: Source = {
		sourceId: "s",
		viewId: crypto.randomUUID(),
		title: "資料",
		url: "https://example.org/page",
		fetchedAt: new Date().toISOString(),
		basis: "page",
		body,
		truncated: false,
	};
	const catalog = new EvidenceCatalog(true);
	const materials = catalog.observe([source]) as Array<{
		excerpts: Array<{ reference: string; quote: string; context?: string[] }>;
	}>;
	const excerpts = materials[0]!.excerpts;
	const row = excerpts.find((e) => e.quote.includes("25.4"))!;
	expect(row.quote).toBe("|13:00|25.4|℃|\n");
	expect(
		row.context?.map((r) => excerpts.find((e) => e.reference === r)!.quote),
	).toEqual(["## 2026-10-16\n", "|時間|値|単位|\n"]);
	const report = catalog.report(
		{
			outcome: "answered",
			summary: "資料の値",
			claims: [
				{ text: "資料の値", evidence: [row.reference, ...row.context!] },
			],
			limitations: [],
		},
		["取得した本文を確認した"],
	);
	expect(
		verifyReport(report, [source], false, true, true).claims[0]!.evidence[0]!
			.quote,
	).toBe(row.quote);
	expect(
		Buffer.byteLength(
			JSON.stringify({ evidence: catalog.list(), observations: materials }),
		),
	).toBeLessThanOrEqual(32768);
});
test("World and archived Web views retain the old excerpt algorithm by default", () => {
	const body = "# heading\n|a|b|\n|---|---|\n|1|2|\n";
	expect(evidenceExcerpts(body)).toEqual([{ excerptId: "e0", quote: body }]);
});
