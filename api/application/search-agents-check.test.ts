import { expect, test } from "bun:test";
import {
	assessSearchAgent,
	searchAgentCases,
	type SearchAgentResult,
} from "./search-agents.fixture";
const c = searchAgentCases[1];
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
		claims: ["モデル公開", "推論の高速化", "AI製品の更新"].map((text) => ({
			text,
		})),
		sources: [{ url: "https://example.org/news" }],
	},
	answer:
		"- モデル公開\n- 推論の高速化\n- AI製品の更新\n[出典](https://example.org/news)",
	operations: [{ operation: "lookup", query: "LLM news" }],
	verifierCalls: { n: 0 },
});
test("accepts one search and a cited three-topic bullet report", () =>
	expect(assessSearchAgent(c, success()).ok).toBe(true));
for (const error of ["invalid_requirement_schema", "codex_research_failed"])
	test(`a completed failure explanation is not a successful search: ${error}`, () => {
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
		"search without AI subject",
		(r: SearchAgentResult) => {
			r.operations[0]!.query = "最新ニュース";
		},
	],
	[
		"repeated search",
		(r: SearchAgentResult) => {
			r.operations.push({ operation: "lookup", query: "AI news" });
		},
	],
	[
		"lost topics",
		(r: SearchAgentResult) => {
			r.report!.claims.pop();
		},
	],
	[
		"lost bullet list",
		(r: SearchAgentResult) => {
			r.answer =
				"モデル公開。推論高速化。製品更新。[出典](https://example.org/news)";
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
