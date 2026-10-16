import { checkLiveCitations } from "./toolchain-live-check";

// Test scenarios and acceptance checks only; never used to route product requests.
export const searchAgentCases = [
	{
		id: "quick",
		question: "仙台市が何県にあるか、Webで調べて教えて",
		expectedPackage: "package:web.recipe@1",
		query: "仙台市 都道府県",
		queryPattern: /仙台|sendai/i,
		facts: ["仙台市は宮城県にあります。"],
		answerPattern: /宮城/,
	},
	{
		id: "codex",
		question: "AIの最新ニュースを教えて",
		expectedPackage: "package:web.search@1",
		query: "AI 最新ニュース",
		queryPattern: /(?:\bAI\b|人工知能|\bLLM\b|transformer)/i,
		facts: [
			"AIモデルAが公開されました。",
			"LLM推論の高速化が発表されました。",
			"音声AI製品が更新されました。",
		],
		answerPattern: /AI|LLM/,
	},
	{
		id: "model-detail",
		question:
			"LFM2.5-24B-A2B というモデルが出たそうです。どんなモデルか調査して詳細を教えて",
		expectedPackage: "package:web.search@1",
		query: "LFM2.5-24B-A2B model specifications",
		queryPattern: /LFM2\.5-24B-A2B/i,
		facts: ["公開資料はLFM2.5-24B-A2Bのモデル構成を説明しています。"],
		answerPattern: /LFM2\.5-24B-A2B/,
	},
	{
		id: "stock",
		question: "マイクロソフトの最新の株価を教えて",
		expectedPackage: "package:web.recipe@1",
		query: "Microsoft MSFT stock price",
		queryPattern: /マイクロソフト|microsoft|\bMSFT\b/i,
		// Deliberately synthetic price/date; never a live quote.
		facts: ["テスト用MSFT株価は2026年10月9日終値で500米ドルです。"],
		answerPattern: /米ドル|USD|\$/i,
		quotePattern:
			/(?:\d[\d,]*(?:\.\d+)?\s*(?:米ドル|ドル|USD)|(?:USD|\$)\s*\d[\d,]*(?:\.\d+)?)/i,
	},
	{
		id: "softbank-stock",
		question: "ソフトバンク（9434）の株価を教えて",
		expectedPackage: "package:web.recipe@1",
		query: "ソフトバンク 9434 株価",
		queryPattern: /ソフトバンク|9434/i,
		// Regression fixture for a report with a price that the final answer omitted.
		facts: ["テスト用ソフトバンク株価は2026年10月14日終値で241.8円です。"],
		answerPattern: /241\.8\s*円/,
		quotePattern: /\d[\d,]*(?:\.\d+)?\s*円/,
	},
	{
		id: "weather",
		question: "今日の東京の天気を教えて",
		expectedPackage: "package:web.recipe@1",
		query: "東京 今日 天気",
		queryPattern: /東京|tokyo/i,
		facts: ["テスト用の東京の予報は2026年10月11日、晴れ、最高気温25度です。"],
		answerPattern: /天気|予報|晴|雨|曇/,
	},
] as const;
export type SearchAgentCase = (typeof searchAgentCases)[number];
export type SearchAgentResult = {
	status?: string;
	tasks: Array<{
		kind: string;
		status: string;
		packageRevisionId?: string | null;
		toolOutcomes?: Array<{ toolRevisionId: string; state: string }>;
	}>;
	report: {
		claims: Array<{ text: string }>;
		sources: Array<{ url?: string }>;
	} | null;
	answer?: string;
	operations: Array<{ operation: string; query?: string }>;
	verifierCalls: { n: number } | null;
};
export function assessSearchAgent(
	c: SearchAgentCase,
	result: SearchAgentResult,
) {
	const worker = result.tasks.find((t) => t.kind === "worker");
	const queries = result.operations.filter((o) => o.operation === "lookup");
	const quotePattern = "quotePattern" in c ? c.quotePattern : null;
	const checks = {
		correctAgent: worker?.packageRevisionId === c.expectedPackage,
		completed: result.status === "completed" && worker?.status === "completed",
		searchedOnce:
			queries.length === 1 &&
			!!worker?.toolOutcomes?.some(
				(o) =>
					o.toolRevisionId === "tool:web.lookup@1" && o.state === "succeeded",
			),
		reportReturned: !!result.report?.claims.length && !!result.answer?.trim(),
		citationsReturned: checkLiveCitations(result.report, result.answer),
		// This is a test-case keyword signal, not semantic grading of news content.
		queryTargetsRequest:
			c.queryPattern.test(queries[0]?.query ?? "") &&
			(c.id !== "codex" || /ニュース|news/i.test(queries[0]?.query ?? "")) &&
			(!quotePattern ||
				/株価|stock|share|quote/i.test(queries[0]?.query ?? "")),
		stockQuote:
			!quotePattern ||
			[
				result.answer ?? "",
				result.report?.claims.map((c) => c.text).join(" ") ?? "",
			].every(
				(text) =>
					quotePattern.test(text) &&
					/(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日)/.test(text),
			),
		requestedResult:
			c.id !== "codex"
				? c.answerPattern.test(result.answer ?? "")
				: (result.report?.claims.length ?? 0) >= 3 &&
					(result.report?.claims.length ?? 0) <= 5,
		bulletList:
			c.id !== "codex" ||
			(() => {
				const n = (
					result.answer?.match(/^\s*(?:[-*・●]|\d+[.)、])\s*\S/gm) ?? []
				).length;
				return n >= 3 && n <= 5;
			})(),
		noGrading: result.verifierCalls?.n === 0,
	};
	return { ok: Object.values(checks).every(Boolean), checks };
}
