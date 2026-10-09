import { test, expect } from "bun:test";
import { publicSourceText } from "../service/source-text";

test("stock times are converted by the host and the requested symbol is verified", () => {
	const raw = JSON.stringify({
		chart: {
			result: [
				{
					meta: {
						symbol: "AAPL",
						currency: "USD",
						regularMarketPrice: 340.42,
						regularMarketTime: 1791489600,
						exchangeTimezoneName: "America/New_York",
						ignored: "upstream extra",
					},
				},
			],
		},
	});
	const text = publicSourceText(
		"https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
		raw,
	);
	const value = JSON.parse(text.split("\n")[1]!);
	expect(value.priceTimeUtc).toBe("2026-10-08T20:00:00.000Z");
	expect(value.priceTimeAtExchange).toBe("2026-10-08 16:00:00");
	expect(value.regularMarketPrice).toBe(340.42);
	expect(text).not.toContain("upstream extra");
	expect(() =>
		publicSourceText(
			"https://query1.finance.yahoo.com/v8/finance/chart/MSFT",
			raw,
		),
	).toThrow("web_quote_symbol_mismatch");
});

test("weather projection preserves date/value pairing and keeps data untrusted", () => {
	const raw = [
		{
			publishingOffice: "気象庁",
			reportDatetime: "2026-10-09T17:00:00+09:00",
			timeSeries: [
				{
					timeDefines: ["2026-10-10T00:00:00+09:00"],
					areas: [
						{
							area: { name: "東京", code: "44132" },
							temps: ["26"],
							weathers: ["晴れ"],
							winds: ["removed"],
						},
					],
				},
			],
		},
	];
	const text = publicSourceText(
		"https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json",
		JSON.stringify(raw),
	);
	expect(text).toContain("未信頼データ");
	expect(text).toContain('"forecastHorizon":"short_range"');
	expect(text).toContain("2026-10-10T00:00:00+09:00");
	expect(
		JSON.parse(text.split("\n")[1]!)[0].timeSeries[0].areas[0].temps,
	).toEqual(["26"]);
	expect(text).not.toContain("removed");
});

import { weatherPageText } from "../service/source-text";
const yahooPage = (place: string) => `
${place}の天気 - Yahoo!天気・災害
パーソナル天気 現在位置： 天気・災害トップ > 関東・信越 > 神奈川県
ピンポイント天気
2026年10月9日　21時00分発表
今日の天気
 - 10月9日(
金
)
時刻 0時 3時 6時 9時 12時 15時 18時 21時
天気 晴れ 晴れ 晴れ 晴れ 晴れ 晴れ 晴れ 晴れ
気温（℃） 19 18 17 21 24 25 22 20
明日の天気
 - 10月10日(
土
)
時刻 0時 3時 6時 9時 12時 15時 18時 21時
天気 晴れ 晴れ 曇り 晴れ 晴れ 晴れ 晴れ 晴れ
気温（℃） 19 17 17 21 25 25 22 20
週間天気
2026年10月9日 20時00分発表
日付 10月11日 (日) 10月12日 (月)
天気 晴れ 晴時々曇
気温（℃） 27 17 26 17
降水 確率（％） 0 10
`;
test("weather page conversion keeps date/value pairing and never invents daily extremes", () => {
	const text = weatherPageText(yahooPage("鎌倉市"))!;
	const lines = text.split("\n").slice(1);
	expect(lines).toEqual([
		"鎌倉市 2026-10-09 天気 晴れ 発表 2026-10-09T21:00:00+09:00",
		"鎌倉市 2026-10-11 天気 晴れ 最高気温 27 最低気温 17 発表 2026-10-09T20:00:00+09:00",
		"鎌倉市 2026-10-12 天気 晴時々曇 最高気温 26 最低気温 17 発表 2026-10-09T20:00:00+09:00",
	]);
	expect(weatherPageText("関係のない文章")).toBeNull();
});
test("quote text carries a host-mapped market from the provider exchange code", () => {
	const raw = (exchangeName?: string) =>
		JSON.stringify({
			chart: {
				result: [
					{
						meta: {
							symbol: "AAPL",
							currency: "USD",
							regularMarketPrice: 1,
							regularMarketTime: 1791489600,
							exchangeTimezoneName: "America/New_York",
							...(exchangeName ? { exchangeName } : {}),
						},
					},
				],
			},
		});
	const url = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL";
	expect(
		JSON.parse(publicSourceText(url, raw("NMS")).split("\n")[1]!).market,
	).toBe("NASDAQ");
	expect(
		JSON.parse(publicSourceText(url, raw("XXX")).split("\n")[1]!).market,
	).toBeUndefined();
});

import { sourceText } from "../adapters/llm-fetch";
test("sourceText normalizes known sources and leaves every other page unchanged", () => {
	const page = yahooPage("鎌倉市");
	const normalized = sourceText(
		"https://weather.yahoo.co.jp/weather/jp/14/4610/14204.html",
		page,
	);
	expect(normalized).toBe(weatherPageText(page)!);
	expect(normalized.split("\n")[1]).toContain("鎌倉市 2026-10-09 天気 晴れ");
	const other = "一般のページ本文。天気の話はしない。";
	expect(sourceText("https://example.com/a", other)).toBe(other);
	const json = JSON.stringify({
		chart: {
			result: [
				{
					meta: {
						symbol: "AAPL",
						currency: "USD",
						regularMarketPrice: 1,
						regularMarketTime: 1791489600,
						exchangeTimezoneName: "America/New_York",
						exchangeName: "NMS",
					},
				},
			],
		},
	});
	expect(
		sourceText(
			"https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d",
			json,
		),
	).toContain("NASDAQ");
});
