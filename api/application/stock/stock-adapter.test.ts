import { expect, test } from "bun:test";
import { createStockAdapter } from "./stock-adapter";
import {
	appleSentence,
	chartJson,
	codeListCsv,
	softbankSentence,
	stockFetch,
	zipOf,
} from "./stock.fixture";

const run = (
	adapter: ReturnType<typeof createStockAdapter>,
	query: unknown,
	signal = new AbortController().signal,
) =>
	adapter.instant!.run(
		"stock.quote",
		typeof query === "string" ? { query } : query,
		signal,
	);

async function loaded(over: Parameters<typeof stockFetch>[0] = {}) {
	const service = stockFetch(over);
	const adapter = createStockAdapter({ fetch: service.fetch });
	await adapter.maintain();
	return { adapter, service };
}

const apple = [{ symbol: "AAPL", longname: "Apple Inc." }];

test("the toolchain is available at once, whether or not the list of companies has been read", () => {
	const adapter = createStockAdapter({ fetch: stockFetch().fetch });
	expect(adapter.availableInTransaction({} as never)).toBe(true);
});

test("a Japanese company name is answered from the list, with the company's formal name and code", async () => {
	const { adapter, service } = await loaded();
	expect(await run(adapter, "ソフトバンク")).toEqual({
		ok: true,
		answer: softbankSentence,
	});
	expect(service.charts()).toEqual([
		"https://query1.finance.yahoo.com/v8/finance/chart/9434.T?range=1d&interval=1d",
	]);
	// the search service refuses non-ASCII text, so it is not asked
	expect(service.searches()).toHaveLength(0);
});

test("a ticker is answered from the search service's hit with that symbol", async () => {
	const { adapter, service } = await loaded({ searches: { AAPL: apple } });
	expect(await run(adapter, "AAPL")).toEqual({
		ok: true,
		answer: appleSentence,
	});
	expect(service.searches()).toHaveLength(1);
	expect(service.charts()[0]).toContain("/chart/AAPL?");
});

test("a securities code goes straight to the chart service", async () => {
	const { adapter, service } = await loaded();
	expect(await run(adapter, "9434")).toEqual({
		ok: true,
		answer: softbankSentence,
	});
	expect(service.searches()).toHaveLength(0);
});

test("a company listed in Japan and abroad is answered with its Japanese listing", async () => {
	const { adapter, service } = await loaded({
		searches: {
			"Toyota Motor": [
				{ symbol: "TM", longname: "Toyota Motor Corporation" },
				{ symbol: "7203.T", longname: "Toyota Motor Corporation" },
			],
		},
		charts: {
			"7203.T": chartJson({ symbol: "7203.T", price: 3105, previous: 3050 }),
			TM: chartJson({
				symbol: "TM",
				currency: "USD",
				price: 200,
				previous: 199,
			}),
		},
	});
	const result = await run(adapter, "Toyota Motor");
	expect(result).toEqual({
		ok: true,
		answer:
			"トヨタ自動車株式会社（7203）の株価は3,105円、前日比+55円（+1.80%）です。10/16 15:30時点。",
	});
	expect(service.charts()).toHaveLength(1);
});

test("an exact name beats one that only starts with it, wherever each was found", async () => {
	const { adapter } = await loaded({
		searches: {
			Apple: [
				{ symbol: "APLE", longname: "Apple Hospitality REIT, Inc." },
				{ symbol: "AAPL", longname: "Apple Inc." },
			],
		},
	});
	expect(await run(adapter, "Apple")).toEqual({
		ok: true,
		answer: appleSentence,
	});
});

test("a company the services do not know is a failure, so the request goes to web search", async () => {
	const { adapter, service } = await loaded();
	expect(await run(adapter, "存在しない会社")).toEqual({
		ok: false,
		code: "stock_not_found",
	});
	expect(await run(adapter, "Nonexistent Holdings")).toEqual({
		ok: false,
		code: "stock_not_found",
	});
	expect(service.charts()).toHaveLength(0);
});

test("a symbol the chart service does not know is a failure", async () => {
	const { adapter } = await loaded({ charts: {} });
	expect(await run(adapter, "ソフトバンク")).toEqual({
		ok: false,
		code: "stock_http_status",
	});
});

test("without the list, a name is found by the search service and a Japanese name is not found", async () => {
	const { adapter } = await loaded({
		codeList: () => new Response("", { status: 503 }),
		searches: { AAPL: apple },
	});
	expect(await run(adapter, "AAPL")).toEqual({
		ok: true,
		answer: appleSentence,
	});
	expect(await run(adapter, "ソフトバンク")).toEqual({
		ok: false,
		code: "stock_not_found",
	});
	// a securities code needs no list
	expect(await run(adapter, "9434")).toMatchObject({ ok: true });
});

test("a failed search does not stop a company the list knows, but a name nobody knows reports the failure", async () => {
	const { adapter } = await loaded({
		search: () => new Response("busy", { status: 429 }),
		charts: {
			"7974.T": chartJson({ symbol: "7974.T", price: 9000, previous: 8900 }),
		},
	});
	expect(await run(adapter, "Nintendo")).toMatchObject({ ok: true });
	expect(await run(adapter, "Unknown Corp")).toEqual({
		ok: false,
		code: "stock_http_status",
	});
});

for (const [name, input] of [
	["an empty query", { query: "  " }],
	["a missing query", {}],
	["an extra argument", { query: "AAPL", range: "5d" }],
	["a query that is too long", { query: "a".repeat(61) }],
] as const)
	test(`${name} is refused without asking a service`, async () => {
		const { adapter, service } = await loaded();
		const before = service.urls.length;
		expect(await run(adapter, input)).toEqual({
			ok: false,
			code: "invalid_input",
		});
		expect(service.urls).toHaveLength(before);
	});

test("another operation is refused", async () => {
	const { adapter } = await loaded();
	expect(
		await adapter.instant!.run(
			"stock.history",
			{ query: "AAPL" },
			new AbortController().signal,
		),
	).toEqual({ ok: false, code: "unsupported_operation" });
});

const failures: Array<[string, () => Response, string]> = [
	[
		"a status other than 200",
		() => new Response("down", { status: 503 }),
		"stock_http_status",
	],
	[
		"a redirect",
		() =>
			new Response(null, {
				status: 302,
				headers: { location: "https://elsewhere.example/" },
			}),
		"stock_http_status",
	],
	[
		"a body that is not JSON",
		() => new Response("<html>"),
		"stock_chart_invalid",
	],
	[
		"a body without a price",
		() =>
			new Response(
				JSON.stringify(chartJson({ symbol: "9434.T", price: null })),
			),
		"stock_chart_invalid",
	],
	[
		"a body without a currency",
		() =>
			new Response(
				JSON.stringify(chartJson({ symbol: "9434.T", currency: null })),
			),
		"stock_chart_invalid",
	],
	[
		"a body over the size limit",
		() => new Response("x".repeat(600 * 1024)),
		"stock_too_large",
	],
];
for (const [name, response, code] of failures)
	test(`${name} from the chart service is a failure of the service`, async () => {
		const { adapter } = await loaded({ chart: response });
		expect(await run(adapter, "ソフトバンク")).toEqual({ ok: false, code });
	});

test("a network error is a failure of the service", async () => {
	const service = stockFetch();
	const adapter = createStockAdapter({
		fetch: (async (input: string | URL | Request) => {
			if (String(input).includes("/v8/finance/chart/"))
				throw new Error("ECONNRESET");
			return service.fetch(input);
		}) as typeof fetch,
	});
	await adapter.maintain();
	expect(await run(adapter, "ソフトバンク")).toEqual({
		ok: false,
		code: "stock_unreachable",
	});
});

test("a cancelled run ends the wait and is not a failure of the service", async () => {
	const service = stockFetch();
	const adapter = createStockAdapter({
		fetch: ((input: string | URL | Request, init?: RequestInit) => {
			if (!String(input).includes("/v8/finance/chart/"))
				return service.fetch(input);
			return new Promise<Response>((_, reject) => {
				const signal = init!.signal!;
				if (signal.aborted) return reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason));
			});
		}) as typeof fetch,
	});
	await adapter.maintain();
	const started = Date.now();
	const controller = new AbortController();
	const pending = run(adapter, "ソフトバンク", controller.signal);
	controller.abort(new Error("cancelled"));
	await expect(pending).rejects.toThrow("cancelled");
	expect(Date.now() - started).toBeLessThan(2000);
});

test("redirects are never followed, a signal and a user agent go with every request", async () => {
	const seen: RequestInit[] = [];
	const service = stockFetch({ searches: { AAPL: apple } });
	const adapter = createStockAdapter({
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push(init!);
			return service.fetch(input);
		}) as typeof fetch,
	});
	await adapter.maintain();
	await run(adapter, "AAPL");
	// the list, the search, the chart
	expect(seen).toHaveLength(3);
	for (const init of seen) {
		expect(init.redirect).toBe("manual");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect((init.headers as Record<string, string>)["user-agent"]).toBeTruthy();
	}
});

test("the query reaches the search service encoded, and the symbol the chart service encoded", async () => {
	const { adapter, service } = await loaded({
		searches: { "A&B c": [{ symbol: "A.B", longname: "A&B c" }] },
		charts: {
			"A.B": chartJson({
				symbol: "A.B",
				currency: "USD",
				price: 5,
				previous: 4,
			}),
		},
	});
	expect(await run(adapter, "A&B c")).toMatchObject({ ok: true });
	expect(service.searches()[0]).toContain("q=A%26B+c");
});

test("a symbol that is not plain text is never put in an address", async () => {
	const { adapter, service } = await loaded({
		searches: { evil: [{ symbol: "../x", longname: "evil" }] },
	});
	expect(await run(adapter, "evil")).toEqual({
		ok: false,
		code: "stock_not_found",
	});
	expect(service.charts()).toHaveLength(0);
});

test("the list is read again after a day, and a failed read keeps the earlier list", async () => {
	let clock = 1_000_000;
	let failing = false;
	const service = stockFetch({
		codeList: () =>
			failing
				? new Response("", { status: 500 })
				: new Response(zipOf("EdinetcodeDlInfo.csv", codeListCsv())),
	});
	const adapter = createStockAdapter({
		fetch: service.fetch,
		now: () => clock,
	});
	const reads = () =>
		service.urls.filter((u) => u.endsWith("Edinetcode.zip")).length;
	await adapter.maintain();
	expect(reads()).toBe(1);
	// Within the day nothing is read.
	clock += 3_600_000;
	await adapter.maintain();
	expect(reads()).toBe(1);
	// After the day the list is read; a failure leaves the earlier one standing and waits before retrying.
	failing = true;
	clock += 24 * 3_600_000;
	await adapter.maintain();
	expect(reads()).toBe(2);
	expect(await run(adapter, "ソフトバンク")).toMatchObject({ ok: true });
	await adapter.maintain();
	expect(reads()).toBe(2);
	clock += 61_000;
	failing = false;
	await adapter.maintain();
	expect(reads()).toBe(3);
});

test("a list that is not the list is not used", async () => {
	const { adapter } = await loaded({
		codeList: () =>
			new Response(
				zipOf("EdinetcodeDlInfo.csv", new TextEncoder().encode("a,b\n1,2\n")),
			),
	});
	expect(await run(adapter, "ソフトバンク")).toEqual({
		ok: false,
		code: "stock_not_found",
	});
});
