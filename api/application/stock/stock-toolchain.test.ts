import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import {
	candidatesOf,
	searchThenDelegate,
	type Candidate,
} from "../toolchain/conversation-script.fixture";
import { softbankSentence, stockFetch } from "./stock.fixture";

const ask = "ソフトバンクの株価を教えて";
/** The stock toolchain is the instant candidate whose inputs take a query. */
const isStock = (candidate: Candidate) =>
	candidate.execution === "instant" &&
	JSON.stringify(candidate.inputs ?? {}).includes("query");

/** The model's usual path: search for the stock toolchain, then answer instantly with the query it reads. */
const askStock = (args: Record<string, unknown> = { query: "ソフトバンク" }) =>
	searchThenDelegate(isStock, ask, { inputs: args });

async function stockHarness(
	over: Parameters<typeof stockFetch>[0] = {},
	extra: Parameters<typeof harness>[0] = {},
	args?: Record<string, unknown>,
) {
	const service = stockFetch(over);
	const candidates: Array<Candidate[] | undefined> = [];
	const h = await harness({
		stock: { fetch: service.fetch },
		firstRound: (_tools, _question, messages) => {
			candidates.push(candidatesOf(messages));
			return askStock(args)(messages);
		},
		...extra,
	});
	await h.toolchain.stock!.maintain();
	return { h, service, candidates };
}

test("a cold stock request is answered after one search and one instant answer: fixed sentence, no TODO, no notice", async () => {
	const { h, service, candidates } = await stockHarness();
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
		// One search, then the instant answer: nothing reached a worker, the web, or a second answer round.
		expect(candidates.filter(Boolean)).toHaveLength(2);
		expect(h.calls).toBe(3);
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
		expect(
			h.store.read((db) => h.dialogue.todosInTransaction(db, "main")),
		).toEqual([]);
	} finally {
		await h.close();
	}
});

test("the search lists the stock toolchain as an instant candidate with a free-text query input and no announcement", async () => {
	const { h, candidates } = await stockHarness();
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		const stock = candidates.find(Boolean)!.find(isStock);
		expect(stock).toBeDefined();
		const inputs = stock!.inputs as {
			properties: Record<string, { type?: string; enum?: unknown[] }>;
			required: string[];
		};
		expect(inputs.properties.query!.type).toBe("string");
		expect(inputs.properties.query!.enum).toBeUndefined();
		expect(inputs.required).toEqual(["query"]);
	} finally {
		await h.close();
	}
});

test("without the stock services configured the stock toolchain is not among the candidates", async () => {
	const candidates: Array<Candidate[] | undefined> = [];
	const h = await harness({
		firstRound: (_tools, _question, messages) => {
			candidates.push(candidatesOf(messages));
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
		const found = candidates.find(Boolean)!;
		expect(found.some(isStock)).toBe(false);
	} finally {
		await h.close();
	}
});

test("a query that is not text goes back for the one structural repair, then fails", async () => {
	const service = stockFetch();
	const h = await harness({
		stock: { fetch: service.fetch },
		firstRound: (_tools, _question, messages) =>
			askStock({ query: 123 })(messages),
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
		expect(service.charts()).toHaveLength(0);
	} finally {
		await h.close();
	}
});

test("a failed quote is returned as the instant result: the run does not fall back to web search", async () => {
	const { h, service } = await stockHarness({
		chart: () => new Response("down", { status: 503 }),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ask,
		});
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		expect(done?.status).toBe("completed");
		expect(service.charts()).toHaveLength(1);
		// No automatic switch: no worker and no web research ran for the request.
		expect(h.workerContexts).toHaveLength(0);
		expect(h.acquisitions).toBe(0);
		expect(h.dialogue.answerText(run.id)).not.toBe(softbankSentence);
	} finally {
		await h.close();
	}
});

test("a ticker request is answered with the foreign company's name and ticker", async () => {
	// The model speaks a short sentence that carries the quote's facts: the verbatim quote segments into three
	// sentences, over the two-sentence speech contract (a model would shorten it the same way).
	const service = stockFetch({
		searches: { AAPL: [{ symbol: "AAPL", longname: "Apple Inc." }] },
	});
	const h = await harness({
		stock: { fetch: service.fetch },
		firstRound: (_tools, _question, messages) => {
			const step = askStock({ query: "AAPL" })(messages);
			return step.text
				? { ...step, text: "Apple Inc.（AAPL）の株価は343.46ドルです。" }
				: step;
		},
	});
	try {
		await h.toolchain.stock!.maintain();
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "AAPLの株価は？",
		});
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(done).toMatchObject({ status: "completed", error: null });
		expect(h.dialogue.answerText(run.id)).toBe(
			"Apple Inc.（AAPL）の株価は343.46ドルです。",
		);
	} finally {
		await h.close();
	}
});
