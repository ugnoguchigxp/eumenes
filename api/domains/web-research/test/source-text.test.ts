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
