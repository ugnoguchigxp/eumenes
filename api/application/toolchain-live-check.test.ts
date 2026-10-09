import { test, expect } from "bun:test";
import {
	checkLiveResearch,
	checkLiveForecastDate,
} from "./toolchain-live-check";
test("live date checking accepts forecast month/day notation and rejects another day", () => {
	const report = {
		summary: "2026年10月10日の鎌倉の天気",
		claims: [
			{
				text: "晴れ",
				evidence: [{ quote: "今日10日の関東は秋晴れ 10/10(Sat)08:03" }],
			},
		],
	};
	expect(checkLiveForecastDate("2026-10-10", report)).toBe(true);
	expect(checkLiveForecastDate("2026-10-11", report)).toBe(false);
	expect(
		checkLiveForecastDate("2026-10-10", {
			...report,
			claims: [
				{ text: "晴れ", evidence: [{ quote: "10/100 110/10 10/10/2025" }] },
			],
		}),
	).toBe(false);
	expect(checkLiveForecastDate("2026-10-10", null)).toBe(false);
});
const stock = {
	claims: [
		{
			text: "AAPLは340.42 USD",
			evidence: [{ quote: '"regularMarketPrice":340.42' }],
		},
		{
			text: "価格の時点",
			evidence: [{ quote: '"priceTimeAtExchange":"2026-10-08 16:00:00"' }],
		},
	],
};
test("live stock checking rejects a different generated price or date, including fabricated source claims", () => {
	expect(
		checkLiveResearch("stock", stock, "340.42米ドル、2026年10月08日16時"),
	).toEqual({ numeric: true, valuesMatch: true, priceTimeVerified: true });
	expect(
		checkLiveResearch("stock", stock, "340.42ドル、26年10月8日16時")
			.priceTimeVerified,
	).toBe(true);
	expect(
		checkLiveResearch("stock", stock, "999.99USD、2026年10月8日16時")
			.valuesMatch,
	).toBe(false);
	expect(
		checkLiveResearch(
			"stock",
			stock,
			"340.42USD または999.99USD、2026年10月8日16時",
		).valuesMatch,
	).toBe(false);
	expect(
		checkLiveResearch("stock", stock, "340.42USD、2026年10月6日16時")
			.priceTimeVerified,
	).toBe(false);
	expect(
		checkLiveResearch(
			"stock",
			{
				claims: [{ ...stock.claims[0]!, text: "999.99 USD" }, stock.claims[1]!],
			},
			"999.99USD、2026年10月8日16時",
		).valuesMatch,
	).toBe(false);
});
test("live weather checking uses the sourced highest-temperature claim rather than another number", () => {
	const report = {
		claims: [
			{ text: "最高気温は26℃", evidence: [{ quote: '"temps":["16","26"]' }] },
		],
	};
	expect(
		checkLiveResearch("weather", report, "最高26度または99度").valuesMatch,
	).toBe(false);
	expect(
		checkLiveResearch("weather", report, "晴れ、最高26度").valuesMatch,
	).toBe(true);
	expect(
		checkLiveResearch("weather", report, "晴れ、最高99度").valuesMatch,
	).toBe(false);
	expect(checkLiveResearch("weather", null, "晴れ、最高26度").valuesMatch).toBe(
		false,
	);
});
