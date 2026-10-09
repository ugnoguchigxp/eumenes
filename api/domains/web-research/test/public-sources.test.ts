import { test, expect } from "bun:test";
import { publicDataUrl, sourceMatchesQuestion, publicInvocationHint } from "..";
import { isPublicJsonSource, fetchPublicJson } from "../adapters/public-json";
test("public data sources have fixed destinations and are limited to the user's requested area or explicit ticker", async () => {
	expect(isPublicJsonSource(publicDataUrl("quote", "AAPL"))).toBe(true);
	expect(isPublicJsonSource(publicDataUrl("forecast", "130000"))).toBe(true);
	for (const url of [
		"http://127.0.0.1/",
		"https://query1.finance.yahoo.com.evil.example/v8/finance/chart/AAPL?interval=1d&range=1d",
		"https://query1.finance.yahoo.com/v8/finance/chart/AAPL?secret=data",
		"https://www.jma.go.jp:444/bosai/forecast/data/forecast/130000.json",
	]) {
		expect(isPublicJsonSource(url)).toBe(false);
		await expect(fetchPublicJson(url)).rejects.toThrow();
	}
	expect(sourceMatchesQuestion("forecast", "130000", "東京の天気")).toBe(true);
	expect(sourceMatchesQuestion("forecast", "270000", "東京の天気")).toBe(false);
	expect(
		sourceMatchesQuestion("quote", "AAPL", "Apple (NASDAQ: AAPL) の株価"),
	).toBe(true);
	expect(sourceMatchesQuestion("quote", "AAPL", "AAPLXの株価")).toBe(false);
	expect(() => publicDataUrl("quote", "AAPL?token=x")).toThrow();
});
test("invocation examples use explicit, unambiguous request targets only", () => {
	expect(publicInvocationHint("東京の明日の天気")).toEqual({
		toolId: "web.forecast",
		arguments: { areaCode: "130000" },
	});
	expect(publicInvocationHint("Apple (NASDAQ: AAPL) の最新株価")).toEqual({
		toolId: "web.quote",
		arguments: { symbol: "AAPL" },
	});
	expect(publicInvocationHint("Appleの株価")).toBeNull();
	expect(publicInvocationHint("AAPLとMSFTの株価")).toBeNull();
	expect(publicInvocationHint("東京と大阪の天気")).toBeNull();
});
test("encoded index tickers are readable and ticker scope never strips a prefix or suffix", () => {
	expect(isPublicJsonSource(publicDataUrl("quote", "^GSPC"))).toBe(true);
	expect(
		isPublicJsonSource(
			"https://query1.finance.yahoo.com/v8/finance/chart/AAPL%2Fsecret?interval=1d&range=1d",
		),
	).toBe(false);
	expect(sourceMatchesQuestion("quote", "GSPC", "^GSPCの株価")).toBe(false);
	expect(sourceMatchesQuestion("quote", "AAPL", "AAPL.Xの株価")).toBe(false);
	expect(sourceMatchesQuestion("quote", "AAPL", "Check AAPL.")).toBe(true);
	expect(publicInvocationHint("^GSPCの株価")).toEqual({
		toolId: "web.quote",
		arguments: { symbol: "^GSPC" },
	});
});
