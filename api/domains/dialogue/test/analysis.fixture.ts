import type { Receipt } from "../../inference";
import type { RequestAnalysis } from "../service/initial-decision";

/** The name of the first round's function: a fake model recognizes that round by it. */
export const ANALYZE = "analyze_request";
/** The name of the second round's explanation function. */
export const UNAVAILABLE = "report_unavailable";

type Tools = ReadonlyArray<{ function: { name: string } }> | undefined;
export const isAnalysisRound = (tools: Tools) =>
	tools?.[0]?.function.name === ANALYZE;

/** The arguments of a request that is answered from hand (general knowledge). */
export function analysisArgs(
	over: Partial<RequestAnalysis> = {},
): RequestAnalysis {
	return {
		goal: "一般的な説明を求めている",
		deliverable: "口頭の答え",
		kind: "knowledge",
		freshness: "not_live",
		conditions: [],
		missing: [],
		next: "answer",
		impact: "none",
		approved: false,
		...over,
	};
}

/** The arguments of a request the toolchains must take (the host-checked kinds). */
export function delegatingArgs(
	over: Partial<RequestAnalysis> = {},
): RequestAnalysis {
	return analysisArgs({
		goal: "担当に任せる依頼",
		deliverable: "操作の完了",
		kind: "action",
		next: "find_toolchain",
		...over,
	});
}

/** The model's answer of the first round. */
export function analysisReceipt(
	requestId: string,
	args: RequestAnalysis | Record<string, unknown> = analysisArgs(),
): Receipt {
	return {
		requestId,
		attemptId: "analysis",
		value: "",
		toolCalls: [
			{ id: "analysis", name: ANALYZE, arguments: JSON.stringify(args) },
		],
	} as unknown as Receipt;
}

/** The model's answer of the second round when no offered toolchain fits. */
export function unavailableReceipt(requestId: string, reply: string): Receipt {
	return {
		requestId,
		attemptId: "unavailable",
		value: "",
		toolCalls: [
			{
				id: "unavailable",
				name: UNAVAILABLE,
				arguments: JSON.stringify({ reply }),
			},
		],
	} as unknown as Receipt;
}
