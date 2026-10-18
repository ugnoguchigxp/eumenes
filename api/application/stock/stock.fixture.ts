import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

/** A trimmed copy of the EDINET code list (2026-10-17, CP932), for fixtures that never reach the network. */
export const codeListCsv = () =>
	new Uint8Array(
		readFileSync(
			new URL("./testdata/edinet-sample.cp932.csv", import.meta.url),
		),
	);

/** A zip file holding one entry, as the publisher serves the code list. */
export function zipOf(name: string, data: Uint8Array, method: 0 | 8 = 8) {
	const body = method === 8 ? deflateRawSync(data) : data;
	const nameBytes = new TextEncoder().encode(name);
	const local = new Uint8Array(30 + nameBytes.length);
	const lv = new DataView(local.buffer);
	lv.setUint32(0, 0x04034b50, true);
	lv.setUint16(4, 20, true);
	lv.setUint16(8, method, true);
	lv.setUint32(18, body.length, true);
	lv.setUint32(22, data.length, true);
	lv.setUint16(26, nameBytes.length, true);
	local.set(nameBytes, 30);
	const central = new Uint8Array(46 + nameBytes.length);
	const cv = new DataView(central.buffer);
	cv.setUint32(0, 0x02014b50, true);
	cv.setUint16(4, 20, true);
	cv.setUint16(6, 20, true);
	cv.setUint16(10, method, true);
	cv.setUint32(20, body.length, true);
	cv.setUint32(24, data.length, true);
	cv.setUint16(28, nameBytes.length, true);
	cv.setUint32(42, 0, true);
	central.set(nameBytes, 46);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, 1, true);
	ev.setUint16(10, 1, true);
	ev.setUint32(12, central.length, true);
	ev.setUint32(16, local.length + body.length, true);
	return new Uint8Array(Buffer.concat([local, body, central, end]));
}

type ChartOptions = {
	symbol: string;
	currency?: string | null;
	price?: number | null;
	previous?: number | null;
	time?: number | null;
	longName?: string | null;
};

/** The chart service's answer for one symbol, trimmed to the fields the sentence reads (the shape of 2026-10-18). */
export function chartJson(o: ChartOptions) {
	return {
		chart: {
			result: [
				{
					meta: {
						currency: o.currency === undefined ? "JPY" : o.currency,
						symbol: o.symbol,
						exchangeName: "JPX",
						instrumentType: "EQUITY",
						regularMarketTime: o.time === undefined ? 1792132200 : o.time,
						regularMarketPrice: o.price === undefined ? 244.7 : o.price,
						longName: o.longName === undefined ? "SoftBank Corp." : o.longName,
						shortName: "SOFTBANK CORP.",
						chartPreviousClose: o.previous === undefined ? 242.7 : o.previous,
					},
					timestamp: [1792108800],
				},
			],
			error: null,
		},
	};
}

export const softbankChart = () => chartJson({ symbol: "9434.T" });
export const appleChart = () =>
	chartJson({
		symbol: "AAPL",
		currency: "USD",
		price: 343.46,
		previous: 342,
		time: 1792180801,
		longName: "Apple Inc.",
	});

export const softbankSentence =
	"ソフトバンク株式会社（9434）の株価は244.7円、前日比+2.0円（+0.82%）です。10/16 15:30時点。";
export const appleSentence =
	"Apple Inc.（AAPL）の株価は343.46ドル、前日比+1.46ドル（+0.43%）です。10/17 5:00時点。";

type Hit = {
	symbol: string;
	longname: string;
	quoteType?: string;
	shortname?: string;
};
/** The search service's answer: hits in the service's own order. */
export const searchJson = (hits: Hit[]) => ({
	explains: [],
	count: hits.length,
	quotes: hits.map((h) => ({
		exchange: "XXX",
		shortname: h.shortname ?? h.longname,
		quoteType: h.quoteType ?? "EQUITY",
		symbol: h.symbol,
		longname: h.longname,
		isYahooFinance: true,
	})),
});

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	});

/**
 * A fetch that answers the three services from fixtures and records every address asked. A symbol with no
 * chart in `charts` is a 404, as the service answers for an unknown symbol; a search for text with no entry
 * in `searches` finds nothing.
 */
export function stockFetch(
	over: {
		codeList?: () => Response;
		searches?: Record<string, Hit[]>;
		search?: (q: string) => Response;
		charts?: Record<string, unknown>;
		chart?: (symbol: string) => Response;
	} = {},
) {
	const urls: string[] = [];
	const charts = over.charts ?? {
		"9434.T": softbankChart(),
		AAPL: appleChart(),
	};
	const fetcher = (async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith("/Edinetcode.zip"))
			return (
				over.codeList?.() ??
				new Response(zipOf("EdinetcodeDlInfo.csv", codeListCsv()), {
					headers: { "content-type": "application/x-zip-compressed" },
				})
			);
		const parsed = new URL(url);
		if (parsed.pathname === "/v1/finance/search") {
			const q = parsed.searchParams.get("q") ?? "";
			return (
				over.search?.(q) ?? jsonResponse(searchJson(over.searches?.[q] ?? []))
			);
		}
		const symbol = /^\/v8\/finance\/chart\/([^/]+)$/.exec(parsed.pathname)?.[1];
		if (!symbol) return new Response("not found", { status: 404 });
		const key = decodeURIComponent(symbol);
		if (over.chart) return over.chart(key);
		return key in charts
			? jsonResponse(charts[key])
			: new Response("not found", { status: 404 });
	}) as typeof fetch;
	return {
		fetch: fetcher,
		urls,
		charts: () => urls.filter((u) => u.includes("/v8/finance/chart/")),
		searches: () => urls.filter((u) => u.includes("/v1/finance/search")),
	};
}
