import { expect, test } from "bun:test";
import {
	assessSearchAgent,
	searchAgentCases,
	type SearchAgentResult,
} from "./search-agents.fixture";
const c = searchAgentCases[0];
const success = (): SearchAgentResult => ({
	status: "completed",
	tasks: [
		{
			kind: "worker",
			status: "completed",
			packageRevisionId: c.expectedPackage,
			toolOutcomes: [
				{ toolRevisionId: "tool:web.lookup@1", state: "succeeded" },
			],
		},
	],
	report: {
		claims: [{ text: "仙台市は宮城県にあります。" }],
		sources: [{ url: "https://example.org/news" }],
	},
	answer: "仙台市は宮城県にあります。[出典](https://example.org/news)",
	operations: [{ operation: "lookup", query: "仙台市 県" }],
	verifierCalls: { n: 0 },
});
test("accepts one search and a cited answer", () =>
	expect(assessSearchAgent(c, success()).ok).toBe(true));
test("a completed failure explanation is not a successful search", () => {
	const result = success();
	result.tasks[0]!.status = "failed";
	result.report = null;
	result.answer = "情報を取得できませんでした。";
	expect(assessSearchAgent(c, result)).toMatchObject({
		ok: false,
		checks: { completed: false, reportReturned: false },
	});
});
for (const [name, change] of [
	[
		"wrong agent",
		(r: SearchAgentResult) => {
			r.tasks[0]!.packageRevisionId = "package:web.quick@1";
		},
	],
	[
		"search without the requested subject",
		(r: SearchAgentResult) => {
			r.operations[0]!.query = "最新ニュース";
		},
	],
	[
		"repeated search",
		(r: SearchAgentResult) => {
			r.operations.push({ operation: "lookup", query: "仙台市 宮城" });
		},
	],
	[
		"lost answer",
		(r: SearchAgentResult) => {
			r.answer = "わかりませんでした。[出典](https://example.org/news)";
		},
	],
	[
		"unacquired citation",
		(r: SearchAgentResult) => {
			r.answer += "[別](https://example.org/invented)";
		},
	],
] as const)
	test(`rejects ${name}`, () => {
		const r = success();
		change(r);
		expect(assessSearchAgent(c, r).ok).toBe(false);
	});

const stock = searchAgentCases.find((c) => c.id === "stock")!;
test("stock acceptance needs a price, currency, timestamp, and price query", () => {
	const result = success();
	result.tasks[0]!.packageRevisionId = stock.expectedPackage;
	result.operations[0]!.query = "Microsoft stock price";
	result.report!.claims = [{ text: stock.facts[0] }];
	result.answer = stock.facts[0] + " [出典](https://example.org/news)";
	expect(assessSearchAgent(stock, result).ok).toBe(true);
	for (const text of [
		"マイクロソフト株は米ドル建てです。",
		"マイクロソフト株は500米ドルです。",
		"2026年10月9日のMSFT株価は500です。",
	])
		expect(
			assessSearchAgent(stock, {
				...result,
				answer: text + " [出典](https://example.org/news)",
			}).ok,
		).toBe(false);
	expect(
		assessSearchAgent(stock, {
			...result,
			operations: [{ operation: "lookup", query: "Microsoft company profile" }],
		}).ok,
	).toBe(false);
});
