import { expect, test } from "bun:test";
import { codeListCsv } from "./stock.fixture";
import { parseCompanies } from "./stock-edinet";
import { normalizeName } from "./stock-names";
import { parseSearch, resolveStock, searchable } from "./stock-resolve";

const companies = parseCompanies(codeListCsv());
const resolve = (
	query: string,
	hits: Parameters<typeof resolveStock>[2] = [],
) => resolveStock(query, companies, hits);

test("names are compared without legal forms, width, kana script, spaces or marks", () => {
	expect(normalizeName("株式会社　ソフトバンク")).toBe("ソフトバンク");
	expect(normalizeName("そふとばんく")).toBe("ソフトバンク");
	expect(normalizeName("Ｓｏｆｔ Ｂａｎｋ Corp.")).toBe("softbank");
	expect(normalizeName("Nintendo Co., Ltd.")).toBe("nintendo");
	expect(normalizeName("ソフトバンクカブシキガイシャ")).toBe("ソフトバンク");
	expect(normalizeName("（株）ソフトバンク")).toBe("ソフトバンク");
	// Only a legal form: it is kept rather than made empty.
	expect(normalizeName("Company")).toBe("company");
});

test("a Japanese company is found by its name, its English name or its reading", () => {
	const softbank = {
		symbol: "9434.T",
		name: "ソフトバンク株式会社",
		code: "9434",
	};
	expect(resolve("ソフトバンク")).toEqual(softbank);
	expect(resolve("株式会社ソフトバンク")).toEqual(softbank);
	expect(resolve("そふとばんく")).toEqual(softbank);
	expect(resolve("任天堂")).toMatchObject({ symbol: "7974.T", code: "7974" });
	expect(resolve("nintendo")).toMatchObject({ symbol: "7974.T" });
	expect(resolve("ニンテンドウ")).toMatchObject({ symbol: "7974.T" });
});

test("among companies of one name the exact one wins, then one that starts with it, then one that contains it", () => {
	// exact: ソフトバンク beats ソフトバンクグループ though both start with it
	expect(resolve("ソフトバンク")).toMatchObject({ code: "9434" });
	expect(resolve("ソフトバンクグループ")).toMatchObject({ code: "9984" });
	// starts with: of those that start with it, the larger capital (トヨタ自動車 over トヨタ紡織)
	expect(resolve("トヨタ")).toMatchObject({ code: "7203" });
	expect(resolve("トヨタ自動車")).toMatchObject({ code: "7203" });
	// contains
	expect(resolve("自動車")).toMatchObject({ code: "7203" });
	// a query of one or two letters is only an exact name, never "starts with"
	expect(resolve("so")).toBeUndefined();
	expect(resolve("ソ")).toBeUndefined();
});

test("a securities code is taken as it is, in either width, with or without the market suffix", () => {
	expect(resolve("9434")).toEqual({
		symbol: "9434.T",
		name: "ソフトバンク株式会社",
		code: "9434",
	});
	expect(resolve("７２０３")).toMatchObject({ symbol: "7203.T" });
	expect(resolve("7203.T")).toMatchObject({ symbol: "7203.T" });
	expect(resolve("130A")).toMatchObject({ symbol: "130A.T" });
	// a code the list does not hold is still a code (a fund, say); the chart service decides
	expect(resolve("1306")).toEqual({
		symbol: "1306.T",
		name: undefined,
		code: "1306",
	});
});

test("a ticker is found as the search service's hit with that symbol", () => {
	expect(
		resolve("AAPL", [
			{ symbol: "AAPL", names: ["Apple Inc."] },
			{ symbol: "APLE", names: ["Apple Hospitality REIT, Inc."] },
		]),
	).toEqual({ symbol: "AAPL", name: undefined, code: "AAPL" });
	// a ticker of lower case is the same ticker
	expect(
		resolve("aapl", [{ symbol: "AAPL", names: ["Apple Inc."] }]),
	).toMatchObject({
		symbol: "AAPL",
	});
});

test("a name is found among the search service's hits by how well it fits", () => {
	const hits = [
		{ symbol: "APLE", names: ["Apple Hospitality REIT, Inc."] },
		{ symbol: "AAPL", names: ["Apple Inc."] },
	];
	// "Apple Inc." is exactly the query; the earlier hit only starts with it
	expect(resolve("Apple", hits)).toMatchObject({ symbol: "AAPL" });
	expect(resolve("Microsoft", hits)).toBeUndefined();
});

test("a Japanese listing wins over a foreign one of the same fit", () => {
	const hits = [
		{ symbol: "TM", names: ["Toyota Motor Corporation"] },
		{
			symbol: "7203.T",
			names: ["Toyota Motor Corporation", "TOYOTA MOTOR CORP"],
		},
	];
	expect(resolve("Toyota Motor", hits)).toEqual({
		symbol: "7203.T",
		name: "トヨタ自動車株式会社",
		code: "7203",
	});
	// without the list the search service's own Japanese hit still wins
	expect(resolveStock("toyota", [], hits)).toEqual({
		symbol: "7203.T",
		name: undefined,
		code: "7203",
	});
	expect(
		resolve("Sony", [{ symbol: "SONY", names: ["Sony Group Corporation"] }]),
	).toMatchObject({
		symbol: "6758.T",
	});
});

test("a better fit abroad is not given up for a looser fit in Japan", () => {
	const hits = [{ symbol: "AAPL", names: ["Apple Inc."] }];
	// "appl" would also be inside some Japanese name; the exact name abroad is what was said
	expect(
		resolveStock(
			"apple",
			[
				{
					code: "1234",
					name: "株式会社テスト",
					capital: 1,
					keys: ["pineapple"],
				},
			],
			hits,
		),
	).toMatchObject({ symbol: "AAPL" });
});

test("futures, currencies and indexes of the search service are not stocks", () => {
	const hits = parseSearch({
		quotes: [
			{
				symbol: "SAAPL=F",
				quoteType: "FUTURE",
				longname: "Apple Inc Single Stock futures",
			},
			{ symbol: "AAPL", quoteType: "EQUITY", longname: "Apple Inc." },
			{ symbol: "SPY", quoteType: "ETF", shortname: "SPDR S&P 500" },
			{ symbol: "bad symbol", quoteType: "EQUITY", longname: "Bad" },
		],
	});
	expect(hits.map((h) => h.symbol)).toEqual(["AAPL", "SPY"]);
	expect(() => parseSearch({ finance: { result: null } })).toThrow(
		"stock_search_invalid",
	);
});

test("only plain ASCII is sent to the search service", () => {
	expect(searchable("Apple")).toBe(true);
	expect(searchable("ＡＰＰＬＥ")).toBe(true);
	expect(searchable("ソフトバンク")).toBe(false);
});

test("among fits of one kind in Japan the larger capital wins, before the closer length", () => {
	const listed = [
		{
			code: "1111",
			name: "テスト工業株式会社",
			capital: 100,
			keys: ["テスト工業"],
		},
		{
			code: "2222",
			name: "テスト自動車製造株式会社",
			capital: 900,
			keys: ["テスト自動車製造"],
		},
	];
	expect(resolveStock("テスト", listed, [])).toMatchObject({ code: "2222" });
	// Without a capital the closer length decides, as before.
	expect(
		resolveStock(
			"テスト",
			listed.map((c) => ({ ...c, capital: 0 })),
			[],
		),
	).toMatchObject({ code: "1111" });
});
