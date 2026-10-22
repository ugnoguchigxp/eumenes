import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { softbankSentence, stockFetch } from "./stock.fixture";

const ask = "ソフトバンクの株価を教えて";
const analysis = {
	kind: "live_info",
	freshness: "live",
	impact: "none",
	approved: false,
};
/** The first round calls the stock function, as the model would for a stock-price request. */
const callsStock = (
	tools: ReadonlyArray<{ function: { name: string } }>,
	args: Record<string, unknown> = { query: "ソフトバンク" },
) =>
	tools.some((t) => t.function.name === "stock_quote")
		? { name: "stock_quote", args: { ...analysis, ...args } }
		: undefined;

async function stockHarness(
	over: Parameters<typeof stockFetch>[0] = {},
	extra: Parameters<typeof harness>[0] = {},
	args?: Record<string, unknown>,
) {
	const service = stockFetch(over);
	const offers: Array<Array<{ name: string; parameters?: any }>> = [];
	const h = await harness({
		stock: { fetch: service.fetch },
		firstRound: (tools) => {
			offers.push(
				tools.map((t) => ({
					name: t.function.name,
					parameters: t.function.parameters,
				})),
			);
			return callsStock(tools, args);
		},
		...extra,
	});
	await h.toolchain.stock!.maintain();
	return { h, service, offers };
}

test("a cold stock request is answered after one discovery and instant selection: fixed sentence, no second round, no notice", async () => {
	const { h, service, offers } = await stockHarness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe(softbankSentence);
		// Cold discovery and candidate selection; nothing reached a worker, the web, or answer generation.
		expect(offers).toHaveLength(1);
		expect(h.calls).toBe(2);
		expect(h.workerContexts).toHaveLength(0);
		expect(h.routeContexts).toHaveLength(0);
		expect(h.acquisitions).toBe(0);
		const final = await (await h.request(`/api/runs/${run.id}`)).json();
		expect(final.announcement ?? null).toBeNull();
		const messages = h.conversation.get("main").messages;
		expect(messages).toHaveLength(2);
		expect(messages.at(-1)!.text).toBe(softbankSentence);
		expect(service.charts()).toEqual([
			"https://query1.finance.yahoo.com/v8/finance/chart/9434.T?range=1d&interval=1d",
		]);
		const traced = h.store.read((db) =>
			db
				.query(
					"SELECT decision,toolchain_id,function_name,outcome FROM toolchain_selections WHERE run_id=?",
				)
				.all(run.id),
		);
		expect(traced).toEqual([
			{
				decision: "toolchain",
				toolchain_id: "stock.quote",
				function_name: "stock_quote",
				outcome: "completed",
			},
		]);
	} finally {
		await h.close();
	}
});

test("the first round offers the stock function with a free-text query and without a notice", async () => {
	const { h, offers } = await stockHarness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		const stock = offers[0]!.find((t) => t.name === "stock_quote")!;
		const properties = stock.parameters.properties;
		expect(properties.query.type).toBe("string");
		expect(properties.query.enum).toBeUndefined();
		expect(properties.announcement).toBeUndefined();
		// After the discovery the analysis is the discovery's: the function takes its own arguments only.
		expect(stock.parameters.required).toEqual(["query"]);
		expect(properties.impact).toBeUndefined();
		const web = offers[0]!.find((t) => t.name === "web_search")!;
		expect(web.parameters.properties.announcement).toBeDefined();
		expect(web.parameters.properties.query).toBeUndefined();
	} finally {
		await h.close();
	}
});

test("without the stock services configured the stock toolchain is not offered", async () => {
	const offers: string[][] = [];
	const h = await harness({
		firstRound: (tools) => {
			offers.push(tools.map((t) => t.function.name));
			return undefined;
		},
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(offers[0]).not.toContain("stock_quote");
		expect(offers[0]).toContain("web_search");
	} finally {
		await h.close();
	}
});

test("a query that is not text goes back for the one structural repair, then fails", async () => {
	let rounds = 0;
	const service = stockFetch();
	const h = await harness({
		stock: { fetch: service.fetch },
		firstRound: (tools) => {
			rounds++;
			return callsStock(tools, { query: 123 });
		},
	});
	try {
		await h.toolchain.stock!.maintain();
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(done?.status).toBe("failed");
		expect(rounds).toBe(2);
		expect(service.charts()).toHaveLength(0);
	} finally {
		await h.close();
	}
});

for (const [name, over, args, charts] of [
	[
		"a status other than 200",
		{ chart: () => new Response("down", { status: 503 }) },
		undefined,
		1,
	],
	[
		"a body that is not a quote",
		{ chart: () => new Response("<html></html>") },
		undefined,
		1,
	],
	["a company that is not found", {}, { query: "存在しない会社" }, 0],
] as const)
	test(`${name} switches the same run to web search with the user's words and no notice`, async () => {
		const { h, service } = await stockHarness(over, {}, args);
		try {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: ask,
			});
			const done = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 8000,
			});
			expect(done?.status).toBe("completed");
			expect(service.charts()).toHaveLength(charts);
			// The web investigation ran for the request as the user said it.
			expect(h.workerContexts.length).toBeGreaterThan(0);
			expect(h.workerContexts[0]).toContain(ask);
			const final = await (await h.request(`/api/runs/${run.id}`)).json();
			expect(final.announcement ?? null).toBeNull();
			expect(h.routeContexts).toHaveLength(0);
			expect(h.dialogue.answerText(run.id)).not.toBe(softbankSentence);
		} finally {
			await h.close();
		}
	});

test("a ticker request is answered with the foreign company's name and ticker", async () => {
	const { h } = await stockHarness(
		{
			searches: { AAPL: [{ symbol: "AAPL", longname: "Apple Inc." }] },
		},
		{},
		{ query: "AAPL" },
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "AAPLの株価は？",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(h.dialogue.answerText(run.id)).toBe(
			"Apple Inc.（AAPL）の株価は343.46ドル、前日比+1.46ドル（+0.43%）です。10/17 5:00時点。",
		);
	} finally {
		await h.close();
	}
});
