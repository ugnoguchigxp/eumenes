import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import { systemContext } from "../../../infrastructure/system-context";
import type { ToolchainCard } from "../../capabilities";
import {
	SPOKEN_REPLY_MAX_CHARS,
	SPOKEN_REPLY_MAX_SENTENCES,
} from "../../delivery";
import type { SelectionAnalysis } from "../../toolchain-history";
import type { ChatMessage } from "./context";
import { LlmJsonError, parseLlmJson } from "../../../infrastructure/llm-json";
import { validationIssues } from "../../../infrastructure/validation-log";
import { z } from "zod";
import {
	announcementSchema,
	operationRejection,
	toolchainDescription,
	unavailableReply,
	type SessionOffers,
} from "./conversation-tools";

/** What the first round judges about the request: the same four values in every function it offers. */
const requestAnalysis = z
	.object({
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
		impact: z
			.enum(["none", "create", "modify_existing", "irreversible"])
			.describe(
				"依頼の種類ではなく、既存のものへの影響。none=答える・調べる・参照するだけ、create=新しいものを設定・作成するだけで既存を変えない、modify_existing=既存の機能・コード・データ・設定・保存物を変える、irreversible=削除・外部送信・公開など取り消せない。",
			),
		approved: z
			.boolean()
			.describe(
				"直前のアシスタント発言が同じ内容の実行確認で、今回の発言がそれへの承認ならtrue。",
			),
	})
	.strict();
export type RequestAnalysis = z.infer<typeof requestAnalysis>;

/** The function a toolchain's turn into the second round is chosen by: the analysis and the notice to the user. */
const toolchainChoice = requestAnalysis.extend({
	announcement: announcementSchema,
});
const unavailableChoice = requestAnalysis.extend(unavailableReply.shape);

export const ANSWER_FUNCTION = "answer";
export const UNAVAILABLE_FUNCTION = "report_unavailable";

/**
 * The first round's decision. `next` is what the called function means: `answer` is answered from hand in the
 * second round, `report_unavailable` is the answer itself, and a toolchain's function hands the request over
 * (its `announcement` is the notice to the user before the second round writes the request for it).
 */
export type FirstRound = RequestAnalysis &
	(
		| { next: "answer" }
		| { next: "report_unavailable"; reply: string }
		| { next: "toolchain"; card: ToolchainCard; announcement: string }
	);

function jsonSchema(schema: z.ZodType) {
	return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * The functions of the first round: each candidate toolchain, `answer` and `report_unavailable`. All carry the
 * analysis; the toolchain's also the notice. None writes the answer or the request for the specialist.
 */
export function analysisTools(
	cards: readonly ToolchainCard[],
	sessions: SessionOffers = new Map(),
): NativeTool[] {
	const offered = new Set(cards.map((c) => c.functionName));
	return [
		...cards.map((card) => ({
			type: "function" as const,
			function: {
				name: card.functionName,
				description:
					toolchainDescription(card, offered, sessions.has(card.functionName)) +
					"。この担当へ任せるときに呼び、予告(announcement)と依頼の分析だけを書きます",
				parameters: jsonSchema(toolchainChoice.strict()),
			},
		})),
		{
			type: "function" as const,
			function: {
				name: ANSWER_FUNCTION,
				description:
					"手元の知識だけで答えられる説明と雑談のときに呼び、依頼の分析だけを書きます。回答文はこの段階では書かず、次の段階で作ります。現在の外部の情報・保存済みの会話の確認・操作・制作が必要な依頼には使えません。",
				parameters: jsonSchema(requestAnalysis),
			},
		},
		{
			type: "function" as const,
			function: {
				name: UNAVAILABLE_FUNCTION,
				description: `提示された担当のどれでも依頼を満たせないときに呼び、その旨を利用者へ短く伝えます。replyがそのまま回答として音声で読み上げられるため、音声整形後の合計${SPOKEN_REPLY_MAX_CHARS}字以内・${SPOKEN_REPLY_MAX_SENTENCES}文以内にします。担当は起動しません。`,
				parameters: jsonSchema(unavailableChoice.strict()),
			},
		},
	];
}

/** Structure only: what cannot be answered from hand must not be answered from hand. */
function consistent(round: FirstRound) {
	const handed =
		round.kind === "live_info" ||
		round.kind === "past_conversation" ||
		round.kind === "action" ||
		round.kind === "creation" ||
		round.freshness === "live";
	if (handed && round.next === "answer")
		throw operationRejection("analysis_answer_mismatch");
}

/** The one function call of the first round, checked; anything else goes back for the structural repair. */
export function validateAnalysis(
	calls: NativeToolCall[],
	cards: readonly ToolchainCard[],
): FirstRound {
	if (calls.length !== 1)
		throw operationRejection("call_count", undefined, [], calls.length);
	const call = calls[0]!;
	const card = cards.find((c) => c.functionName === call.name);
	if (!card && call.name !== ANSWER_FUNCTION && call.name !== UNAVAILABLE_FUNCTION)
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
	const schema = card
		? toolchainChoice.strict()
		: call.name === ANSWER_FUNCTION
			? requestAnalysis
			: unavailableChoice.strict();
	const parsed = schema.safeParse(args);
	if (!parsed.success)
		throw operationRejection(
			"arguments_invalid",
			call,
			validationIssues(parsed.error, args),
		);
	const data = parsed.data as RequestAnalysis & {
		announcement?: string;
		reply?: string;
	};
	const { announcement, reply, ...analysis } = data;
	const round: FirstRound = card
		? { ...analysis, next: "toolchain", card, announcement: announcement! }
		: call.name === ANSWER_FUNCTION
			? { ...analysis, next: "answer" }
			: { ...analysis, next: "report_unavailable", reply: reply! };
	consistent(round);
	return round;
}

/** The judgment of the first round as the selection trace keeps it (never the request itself). */
export function analysisTrace(round: FirstRound): SelectionAnalysis {
	const { kind, freshness, next, impact, approved } = round;
	return { kind, freshness, next, impact, approved };
}

/**
 * The first round's kind as a host record for the answer round, placed next to the current request. It is
 * reference data: the answer is the only call that has use for it.
 */
export function analysisRecord(round: FirstRound): ChatMessage {
	return {
		role: "user",
		content:
			systemContext("dialogue.contexts.request-analysis.record", {}) +
			JSON.stringify({ kind: round.kind }),
	};
}
