import { expect, test } from "bun:test";
import { chartJson } from "./stock.fixture";
import { parseChart, quoteSentence } from "./stock-quote";

const softbank = { name: "ソフトバンク株式会社", code: "9434" };

test("yen: the name and code, the price, the change from the previous close and the time in Japan time", () => {
	expect(
		quoteSentence(parseChart(chartJson({ symbol: "9434.T" })), softbank),
	).toBe(
		"ソフトバンク株式会社（9434）の株価は244.7円、前日比+2.0円（+0.82%）です。10/16 15:30時点。",
	);
});

test("dollars, and a fall (the places shown are those the service gives)", () => {
	const quote = parseChart(
		chartJson({
			symbol: "AAPL",
			currency: "USD",
			price: 341.5,
			previous: 342,
			time: 1792180801,
		}),
	);
	expect(quoteSentence(quote, { name: "Apple Inc.", code: "AAPL" })).toBe(
		"Apple Inc.（AAPL）の株価は341.5ドル、前日比-0.5ドル（-0.15%）です。10/17 5:00時点。",
	);
});

test("whole-yen prices have no decimals and thousands are grouped", () => {
	const quote = parseChart(
		chartJson({ symbol: "7203.T", price: 3105, previous: 3050 }),
	);
	expect(
		quoteSentence(quote, { name: "トヨタ自動車株式会社", code: "7203" }),
	).toBe(
		"トヨタ自動車株式会社（7203）の株価は3,105円、前日比+55円（+1.80%）です。10/16 15:30時点。",
	);
});

test("no change from the previous close", () => {
	const quote = parseChart(
		chartJson({ symbol: "9434.T", price: 242.7, previous: 242.7 }),
	);
	expect(quoteSentence(quote, softbank)).toContain(
		"、前日比±0.0円（0.00%）です。",
	);
});

test("a value the service does not give is left out, never filled in", () => {
	const noPrevious = parseChart(
		chartJson({ symbol: "9434.T", previous: null }),
	);
	expect(quoteSentence(noPrevious, softbank)).toBe(
		"ソフトバンク株式会社（9434）の株価は244.7円です。10/16 15:30時点。",
	);
	const noTime = parseChart(chartJson({ symbol: "9434.T", time: null }));
	expect(quoteSentence(noTime, softbank)).toBe(
		"ソフトバンク株式会社（9434）の株価は244.7円、前日比+2.0円（+0.82%）です。",
	);
	const neither = parseChart(
		chartJson({ symbol: "9434.T", previous: 0, time: null }),
	);
	expect(quoteSentence(neither, softbank)).toBe(
		"ソフトバンク株式会社（9434）の株価は244.7円です。",
	);
});

test("the currency decides the unit; one that is not listed is written as its code", () => {
	const euro = parseChart(
		chartJson({
			symbol: "SAP.DE",
			currency: "EUR",
			price: 150.2,
			previous: 149.2,
		}),
	);
	expect(quoteSentence(euro, { name: "SAP SE", code: "SAP.DE" })).toContain(
		"株価は150.2ユーロ、前日比+1.0ユーロ（+0.67%）です。",
	);
	const other = parseChart(
		chartJson({ symbol: "X", currency: "BRL", price: 10, previous: 9 }),
	);
	expect(quoteSentence(other, { name: "X Corp.", code: "X" })).toContain(
		"株価は10 BRL、前日比+1 BRL（+11.11%）です。",
	);
});

test("an answer without a price or a currency is refused", () => {
	for (const body of [
		chartJson({ symbol: "9434.T", price: null }),
		chartJson({ symbol: "9434.T", price: 0 }),
		chartJson({ symbol: "9434.T", currency: null }),
		chartJson({ symbol: "9434.T", currency: "円" }),
		{ chart: { result: [], error: null } },
		{ chart: { result: null, error: { code: "Not Found" } } },
		"<html></html>",
		null,
	])
		expect(() => parseChart(body)).toThrow("stock_chart_invalid");
});
