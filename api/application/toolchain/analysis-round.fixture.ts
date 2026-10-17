import type { LarmPort } from "../../domains/larm";
import type { RequestAnalysis } from "../../domains/dialogue/service/initial-decision";
import {
	analysisArgs,
	ANALYZE,
	delegatingArgs,
	isAnalysisRound,
} from "../../domains/dialogue/test/analysis.fixture";

type Messages = ReadonlyArray<{ role: string; content: string }>;
type RoundOptions =
	| {
			tools?: ReadonlyArray<{ function: { name: string } }>;
			onToolCalls?: (
				calls: Array<{ id: string; name: string; arguments: string }>,
			) => void;
	  }
	| undefined;

/** The current request (the last user message) as the goal; an image-only request has no text to quote. */
const goalOf = (messages: Messages) =>
	messages
		.filter((m) => m.role === "user")
		.at(-1)
		?.content.trim()
		.slice(0, 300) || "依頼の確認";

function call(options: RoundOptions, args: RequestAnalysis) {
	options!.onToolCalls!([
		{ id: "analysis", name: ANALYZE, arguments: JSON.stringify(args) },
	]);
}

/**
 * The fake model's answer of the first round. When the call is the request analysis it answers with a
 * delegating `analyze_request` whose goal is the current request (as the candidate search will read it)
 * and returns true; any other call is left to the caller.
 */
export function answerAnalysis(
	messages: Messages,
	options: RoundOptions,
	over: Partial<RequestAnalysis> = {},
): boolean {
	if (!isAnalysisRound(options?.tools)) return false;
	call(options, delegatingArgs({ goal: goalOf(messages), ...over }));
	return true;
}

/**
 * A model whose first round (the request analysis) is answered here as a request answered from hand and
 * never reaches the wrapped model; every other call goes through it unchanged. For tests whose model is a
 * transport fake that asserts its own requests (the analysis is then no request of that transport).
 */
export function withLocalAnalysis<T extends LarmPort>(
	model: T,
	over: Partial<RequestAnalysis> = {},
): T {
	const analysed = (
		messages: Messages,
		options: RoundOptions,
	): string | undefined => {
		if (!isAnalysisRound(options?.tools)) return undefined;
		call(options, analysisArgs({ goal: goalOf(messages), ...over }));
		return "";
	};
	return {
		...model,
		answer: async (messages, signal, options) =>
			analysed(messages, options) ?? model.answer(messages, signal, options),
		...(model.answerStream
			? {
					answerStream: async (
						messages: Parameters<NonNullable<T["answerStream"]>>[0],
						signal: AbortSignal,
						onDelta: (text: string) => void,
						options?: Parameters<T["answer"]>[2],
					) =>
						analysed(messages, options) ??
						model.answerStream!(messages, signal, onDelta, options),
				}
			: {}),
	};
}
