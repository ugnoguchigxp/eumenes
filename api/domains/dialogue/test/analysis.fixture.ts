import type { Receipt } from "../../inference";
import type { RequestAnalysis } from "../service/initial-decision";

/** The first round's functions that no toolchain owns. */
export const DISCOVERY = "find_toolchain";
export const ANSWER = "answer";
export const UNAVAILABLE = "report_unavailable";

type Tools = ReadonlyArray<{ function: { name: string } }> | undefined;
/** A fake model recognizes the first round by its `answer` function: the second round never offers it. */
export const isAnalysisRound = (tools: Tools) =>
	!!tools?.some((t) => t.function.name === ANSWER);
/** The completion check of a delegated result offers `check_request`; nothing else does. */
export const COMPLETION = "check_request";
export const isCompletionCheck = (tools: Tools) =>
	!!tools?.some((t) => t.function.name === COMPLETION);
/** The completion check's call that every condition of the request was satisfied by its first step. */
export const finishCall = () => ({
	id: crypto.randomUUID(),
	name: COMPLETION,
	arguments: JSON.stringify({
		conditions: [{ condition: "依頼", step: 1 }],
		achieved: "",
		need: "",
	}),
});
/** The toolchain functions among the first round's offer, in order. */
export const offeredToolchains = (tools: Tools) =>
	(tools ?? [])
		.map((t) => t.function.name)
		.filter(
			(name) => name !== ANSWER && name !== UNAVAILABLE && name !== DISCOVERY,
		);

/** The analysis of a request that is answered from hand (general knowledge). */
export function analysisArgs(
	over: Partial<RequestAnalysis> = {},
): RequestAnalysis {
	return {
		kind: "knowledge",
		freshness: "not_live",
		impact: "none",
		approved: false,
		...over,
	};
}

/** The analysis of a request the toolchains must take (the host-checked kinds). */
export function delegatingArgs(
	over: Partial<RequestAnalysis> = {},
): RequestAnalysis {
	return analysisArgs({ kind: "action", ...over });
}

/** The default notice a toolchain function of the first round carries. */
export const NOTICE = "担当に引き継ぎます。";

/**
 * The model's answer of the first round: the function it calls (a toolchain's, `answer`, or
 * `report_unavailable`) with the analysis and, for the last two, nothing else but the reply.
 */
export function analysisReceipt(
	requestId: string,
	call: {
		name?: string;
		args?: Partial<RequestAnalysis> & Record<string, unknown>;
		announcement?: string;
		reply?: string;
	} = {},
): Receipt {
	const name = call.name ?? ANSWER;
	const base = name === ANSWER ? analysisArgs() : delegatingArgs();
	return {
		requestId,
		attemptId: "analysis",
		value: "",
		toolCalls: [
			{
				id: "analysis",
				name,
				arguments: JSON.stringify({
					...base,
					...(name === UNAVAILABLE
						? { reply: call.reply ?? "お任せできる担当がありません。" }
						: name === DISCOVERY
							? { query: "今回の依頼を実行する担当" }
							: name === ANSWER
								? {}
								: { announcement: call.announcement ?? NOTICE }),
					...call.args,
				}),
			},
		],
	} as unknown as Receipt;
}

/** The model's answer of the first round when no offered toolchain fits. */
export function unavailableReceipt(requestId: string, reply: string): Receipt {
	return analysisReceipt(requestId, { name: UNAVAILABLE, reply });
}
