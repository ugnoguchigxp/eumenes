import { expect, test } from "bun:test";
import { verifyReport, parentProjection } from "../service/verify-report";
import type { Source } from "../../tool-runtime";
const source = (body: string): Source => ({
	sourceId: "same-source",
	viewId: crypto.randomUUID(),
	kind: "web_source",
	url: "https://example.com/fixture",
	title: "fixture",
	basis: "page",
	fetchedAt: "2026-10-10T00:00:00Z",
	body,
	truncated: false,
});
const raw = (s: Source) => ({
	version: 2,
	outcome: "answered",
	summary: "確認済み",
	claims: [
		{
			text: "事実",
			evidence: [{ sourceId: s.sourceId, viewId: s.viewId, excerptId: "e0" }],
		},
	],
	limitations: [],
	exploration: ["合成資料"],
});
test("R7: equal e0 identifiers in different views never redirect an old quotation; unpresented and forged views fail", () => {
	const old = source("旧版の値は10。"),
		current = { ...source("別範囲の値は20。"), sourceId: old.sourceId };
	expect(() => verifyReport(raw(old), [current], false, true)).toThrow(
		"invalid_evidence",
	);
	expect(() =>
		verifyReport(
			raw({ ...current, viewId: crypto.randomUUID() }),
			[old, current],
			false,
			true,
		),
	).toThrow("invalid_evidence");
	expect(
		verifyReport(raw(current), [old, current], false, true).claims[0]!
			.evidence[0]!.quote,
	).toBe("別範囲の値は20。");
	expect(() =>
		verifyReport(
			{
				summary: "旧形式",
				claims: [
					{
						text: "旧版",
						evidence: [{ sourceId: old.sourceId, quote: old.body }],
					},
				],
				limitations: [],
			},
			[old],
			false,
			true,
		),
	).toThrow("invalid_report");
});
test("zero evidence has bounded not_found/clarification/failed outcomes; answered/partial still require evidence", () => {
	for (const outcome of [
		"not_found",
		"clarification_required",
		"failed",
	] as const) {
		const report = verifyReport(
			{
				version: 2,
				outcome,
				summary: "確認範囲で根拠がありません",
				claims: [],
				limitations: ["未走査の範囲があります"],
				exploration: ["許可された会話の500件"],
			},
			[],
			false,
			true,
		);
		expect(report.sources).toEqual([]);
		expect(parentProjection(report).outcome).toBe(outcome);
	}
	for (const outcome of ["answered", "partial"])
		expect(() =>
			verifyReport(
				{
					version: 2,
					outcome,
					summary: "無根拠",
					claims: [],
					limitations: [],
					exploration: ["合成資料"],
				},
				[],
				false,
				true,
			),
		).toThrow("invalid_report");
});
