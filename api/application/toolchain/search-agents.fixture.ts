import { checkLiveCitations } from "./toolchain-live-check";

// Test scenarios and acceptance checks only; never used to route product requests.
export const searchAgentCases = [
	{
		id: "quick",
		question: "仙台市が何県にあるか、Webで調べて教えて",
		expectedPackage: "package:web.recipe@1",
		queryPattern: /仙台|sendai/i,
		answerPattern: /宮城/,
	},
	{
		id: "stock",
		question: "マイクロソフトの最新の株価を教えて",
		expectedPackage: "package:web.recipe@1",
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
		queryPattern: /ソフトバンク|9434/i,
		// Regression: the final answer must keep the price in the report.
		answerPattern: /241\.8\s*円/,
		quotePattern: /\d[\d,]*(?:\.\d+)?\s*円/,
	},
	{
		id: "weather",
		question: "今日の東京の天気を教えて",
		expectedPackage: "package:web.recipe@1",
		queryPattern: /東京|tokyo/i,
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
		requestedResult: c.answerPattern.test(result.answer ?? ""),
		noGrading: result.verifierCalls?.n === 0,
	};
	return { ok: Object.values(checks).every(Boolean), checks };
}
