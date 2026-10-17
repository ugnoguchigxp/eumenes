import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import { systemContext } from "../../../infrastructure/system-context";
import type { SelectionAnalysis } from "../../toolchain-history";
import type { ChatMessage } from "./context";
import { LlmJsonError, parseLlmJson } from "../../../infrastructure/llm-json";
import { validationIssues } from "../../../infrastructure/validation-log";
import { z } from "zod";
import { operationRejection } from "./conversation-tools";

/** What the first round judged about the request. It decides the second round; it executes nothing. */
const requestAnalysis = z
	.object({
		goal: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.describe(
				"依頼の分析結果。利用者が何を知りたい・してほしいかを、対象と目的が分かる一文で書く。直前の1往復を受けた続きの依頼は、補って完結した依頼にする。相対的な日時は具体的な日付に直さず、原文の表現を残す。",
			),
		deliverable: z
			.string()
			.trim()
			.min(1)
			.max(120)
			.describe(
				"期待される成果の形。例: 口頭の答え、根拠付きの調査結果、画像、操作の完了、過去発言の引用。",
			),
		kind: z
			.enum([
				"knowledge",
				"live_info",
				"past_conversation",
				"action",
				"creation",
				"chat",
			])
			.describe(
				"問い合わせの種類。knowledge=一般知識・説明、live_info=現在時点の外部情報(日付・時刻そのものを含む)、past_conversation=保存済み会話の確認、action=操作、creation=制作、chat=雑談・相づち。",
			),
		freshness: z
			.enum(["live", "not_live"])
			.describe(
				"答えが時間とともに変わり、現在時点の情報が必要ならlive。そうでなければnot_live。",
			),
		conditions: z
			.array(z.string().trim().min(1).max(120))
			.max(20)
			.describe(
				"依頼にある対象・場所・日時・数値を原文のまま並べる。相対的な日時は解決しない。なければ空。",
			),
		missing: z
			.array(z.string().trim().min(1).max(120))
			.max(10)
			.describe("進めるために欠けている必須情報。なければ空。"),
		next: z
			.enum(["answer", "clarify", "find_toolchain"])
			.describe(
				"次の段階。answer=手元の知識だけで答える、clarify=欠けた必須情報を尋ねる(missingがあるときだけ)、find_toolchain=担当を探して任せる。",
			),
		impact: z
			.enum(["none", "create", "modify_existing", "irreversible"])
			.describe(
				"依頼の影響。none=答える・調べる・参照するだけ、create=新しい成果物を作るだけで既存を変えない、modify_existing=既存の機能・コード・データ・設定・保存物を変える、irreversible=削除・外部送信・公開など取り消せない。",
			),
		approved: z
			.boolean()
			.describe(
				"直前のアシスタント発言が同じ内容の実行確認で、今回の発言がそれへの承認ならtrue。",
			),
	})
	.strict();
export type RequestAnalysis = z.infer<typeof requestAnalysis>;

/** The first round's only function: it records the judgment and neither selects a specialist nor executes work. */
export const analyzeTool: NativeTool = {
	type: "function",
	function: {
		name: "analyze_request",
		description:
			"今回の依頼を分析した結果を記録します。依頼の目的、成果の形、問い合わせの種類、情報の鮮度、欠けている必須情報、次の段階を判断します。回答の作成や担当の実行はしません。",
		parameters: z.toJSONSchema(requestAnalysis) as Record<string, unknown>,
	},
};

/** Structure only: the kinds and the freshness that cannot be answered from hand, and when a question is allowed. */
function consistent(analysis: RequestAnalysis) {
	const delegated =
		analysis.kind === "live_info" ||
		analysis.kind === "past_conversation" ||
		analysis.kind === "action" ||
		analysis.kind === "creation" ||
		analysis.freshness === "live";
	if (delegated && analysis.next !== "find_toolchain")
		throw operationRejection("analysis_next_mismatch");
	if (analysis.next === "clarify" && analysis.missing.length === 0)
		throw operationRejection("analysis_clarify_without_missing");
}

/** The one `analyze_request` call of the first round, checked; anything else goes back for the structural repair. */
export function validateAnalysis(calls: NativeToolCall[]): RequestAnalysis {
	if (calls.length !== 1)
		throw operationRejection("call_count", undefined, [], calls.length);
	const call = calls[0]!;
	if (call.name !== analyzeTool.function.name)
		throw operationRejection("tool_not_offered", call);
	let args: unknown;
	try {
		args = parseLlmJson(call.arguments);
	} catch (error) {
		throw operationRejection(
			"arguments_not_json",
			call,
			error instanceof LlmJsonError
				? [{ validationPath: "arguments", validationCode: error.code }]
				: [],
		);
	}
	const parsed = requestAnalysis.safeParse(args);
	if (!parsed.success)
		throw operationRejection(
			"arguments_invalid",
			call,
			validationIssues(parsed.error, args),
		);
	consistent(parsed.data);
	return parsed.data;
}

/** The judgment of the first round as the selection trace keeps it (never the request itself). */
export function analysisTrace(analysis: RequestAnalysis): SelectionAnalysis {
	const { kind, freshness, next, impact, approved } = analysis;
	return { kind, freshness, next, impact, approved };
}

/**
 * The analysis as a host record for the second round, placed next to the current request. It is reference
 * data: the selection call has no use for the kind, the answer does.
 */
export function analysisRecord(
	analysis: RequestAnalysis,
	withKind: boolean,
): ChatMessage {
	const { goal, deliverable, kind, conditions, missing } = analysis;
	return {
		role: "user",
		content:
			systemContext("dialogue.contexts.request-analysis.record", {}) +
			JSON.stringify({
				goal,
				deliverable,
				...(withKind ? { kind } : {}),
				conditions,
				missing,
			}),
	};
}
