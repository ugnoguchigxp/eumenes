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
	candidate.execution === "instant" && candidate.text.includes("query（");

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

test("a cold stock request is answered after the host's search and one choice: fixed sentence, no TODO, no notice", async () => {
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
		// The host searched and the one choice named the quote with its query: the host said the answer, and nothing
		// reached a worker, the web, or another model call.
		expect(candidates.filter(Boolean)).toHaveLength(1);
		expect(h.calls).toBe(1);
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
		// The inputs read as `name（type、required）description` (section 9): free text, no choices.
		expect(stock!.text).toContain("query（string、必須）");
		expect(stock!.text).not.toContain("値は");
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

test("a query that is not text is refused, the choice is made once more with the reason, and nothing is fetched", async () => {
	const service = stockFetch();
	const refusals: string[] = [];
	const h = await harness({
		stock: { fetch: service.fetch },
		// The talk turn's answer once the choice gave up.
		parentAnswer: "株価を取得できませんでした。",
		firstRound: (_tools, _question, messages) => {
			// The refusal comes back as the retry's reason; the model gives up and chooses none (the talk turn answers).
			const retry = messages
				.at(-1)!
				.content.split("\n")
				.find((line) => line.startsWith("前の選び方では頼めませんでした"));
			if (retry) {
				refusals.push(retry);
				return {};
			}
			return askStock({ query: 123 })(messages);
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
		expect(done?.status).toBe("completed");
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain("refused: true");
		expect(h.dialogue.answerText(run.id)).toBe("株価を取得できませんでした。");
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
	// The host says the quote's own sentence (the local harness's routed turn): it names the company and the ticker.
	const service = stockFetch({
		searches: { AAPL: [{ symbol: "AAPL", longname: "Apple Inc." }] },
	});
	const h = await harness({
		stock: { fetch: service.fetch },
		firstRound: (_tools, _question, messages) =>
			askStock({ query: "AAPL" })(messages),
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
		expect(h.dialogue.answerText(run.id)).toStartWith(
			"Apple Inc.（AAPL）の株価は343.46ドル",
		);
	} finally {
		await h.close();
	}
});
