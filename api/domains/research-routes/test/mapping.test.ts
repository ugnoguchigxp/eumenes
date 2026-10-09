import { expect, test } from "bun:test";
import { buildSearchSpec } from "..";
import { hitCoversSource } from "../service/mapping";

const quote = (q: string) => {
	const r = buildSearchSpec(q);
	if (r.kind !== "matched") throw new Error(q);
	return r.spec;
};
const chart = (t: string) =>
	`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=1d`;
const aapl = quote("株価 AAPL");

test("quote hit ↔ Yahoo chart mapping is exact on ticker, host, scheme and tool", () => {
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"https://finance.yahoo.com/quote/AAPL/",
			chart("AAPL"),
		),
	).toBe(true);
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"https://finance.yahoo.com/quote/AAPL",
			chart("AAPL"),
		),
	).toBe(true);
	// another ticker, another host, plain http, deeper path, a port
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"https://finance.yahoo.com/quote/MSFT/",
			chart("AAPL"),
		),
	).toBe(false);
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"https://example.com/quote/AAPL/",
			chart("AAPL"),
		),
	).toBe(false);
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"http://finance.yahoo.com/quote/AAPL/",
			chart("AAPL"),
		),
	).toBe(false);
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"https://finance.yahoo.com/quote/AAPL/options",
			chart("AAPL"),
		),
	).toBe(false);
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"https://finance.yahoo.com:444/quote/AAPL/",
			chart("AAPL"),
		),
	).toBe(false);
	// the data URL must be the chart endpoint of the spec's own ticker
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"https://finance.yahoo.com/quote/AAPL/",
			chart("MSFT"),
		),
	).toBe(false);
	expect(
		hitCoversSource(
			aapl,
			"web.quote",
			"https://finance.yahoo.com/quote/AAPL/",
			"https://evil.test/v8/finance/chart/AAPL",
		),
	).toBe(false);
	// the mapping is for the dedicated tool only; web.read keeps exact equality
	expect(
		hitCoversSource(
			aapl,
			"web.read",
			"https://finance.yahoo.com/quote/AAPL/",
			chart("AAPL"),
		),
	).toBe(false);
	expect(hitCoversSource(aapl, "web.read", chart("AAPL"), chart("AAPL"))).toBe(
		true,
	);
});

test("weather never uses the quote mapping", () => {
	const r = buildSearchSpec("天気予報 鎌倉");
	if (r.kind !== "matched") throw new Error("spec");
	expect(
		hitCoversSource(
			r.spec,
			"web.read",
			"https://finance.yahoo.com/quote/AAPL/",
			chart("AAPL"),
		),
	).toBe(false);
});
