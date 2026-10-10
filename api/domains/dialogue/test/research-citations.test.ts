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

const wiki = "https://en.wikipedia.org/wiki/Foo_(bar)";
const wikiProjection = JSON.stringify({ sources: [{ url: wiki }] });
test("a URL containing parentheses is kept when granted and leaves no stray parenthesis otherwise", () => {
	expect(researchCitations(`見て [Wiki](${wiki}) です`, wikiProjection)).toBe(
		`見て [Wiki](${wiki}) です`,
	);
	expect(researchCitations(`見て [Wiki](${wiki}) です`, projection)).toBe(
		"見て Wiki です",
	);
});
test("raw URLs, autolinks, titled links and reference links cannot smuggle ungranted URLs", () => {
	for (const text of [
		"詳細は https://evil.example/x です",
		"詳細は <https://evil.example/x> です",
		'詳細は [x](https://evil.example "t") です',
		"詳細は [a][1] です\n\n[1]: https://evil.example/x",
		"詳細は [https://evil.example/x](https://evil.example/x) です",
	])
		expect(researchCitations(text, projection)).not.toContain("evil.example");
});
test("granted URLs survive as raw URL, autolink and titled link", () => {
	expect(researchCitations(`詳細は ${url} です`, projection)).toBe(
		`詳細は ${url} です`,
	);
	expect(researchCitations(`詳細は <${url}> です`, projection)).toBe(
		`詳細は <${url}> です`,
	);
	expect(
		researchCitations(`詳細は [天気](${url} "title") です`, projection),
	).toBe(`詳細は [天気](${url} "title") です`);
});
test("images are never kept, only their alt text", () => {
	expect(researchCitations(`![x](${url})`, projection)).toBe("x");
	expect(
		researchCitations("![x](https://evil.example/p.png)", projection),
	).toBe("x");
});
test("trailing punctuation is not part of a raw URL, balanced parentheses are", () => {
	expect(researchCitations(`(${url})`, projection)).toBe(`(${url})`);
	expect(researchCitations(`見て ${url}。`, projection)).toBe(`見て ${url}。`);
	expect(researchCitations("(https://evil.example/x). 以上", projection)).toBe(
		"(). 以上",
	);
});
