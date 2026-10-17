import type { LarmPort } from "../../domains/larm";
import type { RequestAnalysis } from "../../domains/dialogue/service/initial-decision";
import {
	analysisReceipt,
	ANSWER,
	isAnalysisRound,
	offeredToolchains,
	UNAVAILABLE,
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

/** The function the first round calls (default: the first toolchain offered) and the notice it carries. */
type Choice = { call?: string; announcement?: string };

function call(options: RoundOptions, name: string, announcement?: string) {
	options!.onToolCalls!(
		analysisReceipt("analysis", { name, announcement }).toolCalls as never,
	);
}

/**
 * The fake model's answer of the first round. When the call is the first round it calls `over.call` (or the
 * first toolchain offered, or `report_unavailable` when none is) with the analysis `over` and returns true;
 * any other call is left to the caller, whose second round then writes the request for that function.
 */
export function answerAnalysis(
	options: RoundOptions,
	over: Partial<RequestAnalysis> & Choice = {},
): boolean {
	if (!isAnalysisRound(options?.tools)) return false;
	const { call: named, announcement, ...analysis } = over;
	options!.onToolCalls!(
		analysisReceipt("analysis", {
			name: named ?? offeredToolchains(options?.tools)[0] ?? UNAVAILABLE,
			args: analysis,
			announcement,
		}).toolCalls as never,
	);
	return true;
}

/**
 * A model whose first round is answered here as a request answered from hand and never reaches the wrapped
 * model; every other call goes through it unchanged. For tests whose model is a transport fake that asserts
 * its own requests (the first round is then no request of that transport).
 */
export function withLocalAnalysis<T extends LarmPort>(model: T): T {
	const analysed = (
		_messages: Messages,
		options: RoundOptions,
	): string | undefined => {
		if (!isAnalysisRound(options?.tools)) return undefined;
		call(options, ANSWER);
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
