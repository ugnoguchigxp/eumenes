import { expect, test } from "bun:test";
import { researchCitations } from "../service/research-citations";

const url = "https://tenki.jp/forecast/3/17/4610/14204/";
const projection = JSON.stringify({ sources: [{ sourceId: "weather", url }] });
test("research preserves acquired URLs and removes fabricated or obsolete citations", () => {
	const answer = `調べました。晴れ、最高26度、最低17度です。\n\nソース：[tenki.jp](${url})`;
	expect(researchCitations(answer, projection)).toBe(answer);
	for (const wrong of [
		"https://tenki.jp/",
		"https://example.com/old",
		"javascript:bad",
	])
		expect(
			researchCitations(`晴れです。\nソース：[天気](${wrong})`, projection),
		).toBe("晴れです。");
	expect(
		researchCitations(
			`晴れです。\nソース：[天気](${url})、[旧資料](https://example.com/old)`,
			projection,
		),
	).toContain(`[天気](${url})`);
	expect(
		researchCitations(
			`晴れです。\nソース：[天気](${url})、[旧資料](https://example.com/old)`,
			projection,
		),
	).not.toContain("旧資料");
	expect(
		researchCitations(
			"本文の[説明](https://example.com/unknown)も残します。",
			projection,
		),
	).toBe("本文の説明も残します。");
});
test("a failed report grants no citations, even if an earlier turn supplied that URL", () => {
	for (const missing of [
		undefined,
		"{}",
		'{"failure":"invalid_tool_input"}',
		"invalid JSON",
	])
		expect(
			researchCitations(
				`確認できませんでした。\n\nソース：[tenki.jp](${url})`,
				missing,
			),
		).toBe("確認できませんでした。");
});
