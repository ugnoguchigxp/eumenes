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
	executionControl,
	type ExecutionReference,
	type ExecutionView,
} from "../../tool-runtime";
import {
	announcementSchema,
	operationRejection,
	toolchainDescription,
	unavailableReply,
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
				"直前のアシスタント発言が同じ内容の実行確認で、今回の発言がそれへの承認ならtrue。それ以外はfalse。通常の質問・新規依頼・前回の回答や作業完了報告への続きはfalse。過去の承認は引き継がない。",
			),
	})
	.strict();
export type RequestAnalysis = z.infer<typeof requestAnalysis>;

/** The function a toolchain's turn into the second round is chosen by: the analysis and the notice to the user. */
const toolchainChoice = requestAnalysis.extend({
	announcement: announcementSchema,
});
const taskChoice = toolchainChoice
	.extend({
		request: z
			.string()
			.trim()
			.min(1)
			.max(8000)
			.describe("依頼全体の目的と明示条件。最初の一操作だけに縮めない。"),
		contextRefs: z.array(z.string().max(160)).max(32),
	})
	.strict();
const controlChoice = requestAnalysis
	.extend(executionControl.shape)
	.extend({ announcement: announcementSchema })
	.strict();
export type TaskOffer = {
	card: ToolchainCard | undefined;
	references: ExecutionReference[];
	works: ExecutionView[];
};
const unavailableChoice = requestAnalysis.extend(unavailableReply.shape);

const discoveryChoice = requestAnalysis
	.extend({
		query: z
			.string()
			.trim()
			.min(1)
			.max(2000)
			.describe(
				"今回の依頼に必要な担当の用途を表す検索文。対象・時点・条件を保ちます。",
			),
	})
	.strict();
const DISCOVERY_FUNCTION = "find_toolchain";
const ANSWER_FUNCTION = "answer";
const UNAVAILABLE_FUNCTION = "report_unavailable";

/**
 * The first round's decision. `next` is what the called function means: `answer` is answered from hand in the
 * second round, `report_unavailable` is the answer itself, and a toolchain's function hands the request over
 * (its `announcement` is the notice to the user before the second round writes the request for it).
 */
export type FirstRound = RequestAnalysis &
	(
		| { next: "answer" }
		| { next: "find_toolchain"; query: string }
		| { next: "report_unavailable"; reply: string }
		| { next: "toolchain"; card: ToolchainCard; announcement: string }
		| {
				next: "execute_task";
				card: ToolchainCard;
				announcement: string;
				request: string;
				contextRefs: string[];
		  }
		| {
				next: "task_control";
				announcement: string;
				control: z.infer<typeof executionControl>;
		  }
		/** An instant-answer toolchain: its arguments (checked by the card) are all the call carries. */
		| {
				next: "instant";
				card: InstantCard;
				arguments: Record<string, unknown>;
		  }
	);
/** A card whose toolchain answers at once from the arguments of the first round's call. */
export type InstantCard = ToolchainCard & {
	instant: NonNullable<ToolchainCard["instant"]>;
};

function jsonSchema(schema: z.ZodType) {
	return z.toJSONSchema(schema) as Record<string, unknown>;
}

/** Common analysis fields are already defined by the R1 policy and the other offered functions. */
function taskParameters(schema: z.ZodType) {
	const json = jsonSchema(schema);
	delete json.$schema;
	const properties = json.properties as Record<
		string,
		{ description?: string }
	>;
	for (const name of [...Object.keys(requestAnalysis.shape), "announcement"])
		delete properties[name]?.description;
	for (const name of ["workRef", "questionRef"])
		if (properties[name])
			delete (properties[name] as { pattern?: string }).pattern;
	return json;
}

/**
 * The functions of the first round: each candidate toolchain, `answer` and `report_unavailable`. All carry the
 * analysis; the toolchain's also the notice. None writes the answer or the request for the specialist.
 */
export function analysisTools(
	cards: readonly ToolchainCard[],
	sessions: ReadonlySet<string> = new Set(),
	allowDiscovery = false,
	tasks?: TaskOffer,
	approvalReference = true,
): NativeTool[] {
	const offered = new Set(cards.map((c) => c.functionName));
	const tools: NativeTool[] = [
		...(tasks?.card
			? [
					{
						type: "function" as const,
						function: {
							name: tasks.card.functionName,
							description:
								tasks.card.summary +
								"。複数の担当呼出しが必要な依頼に使う。一担当で完結する依頼はfind_toolchainで探して直接使う。requestに依頼全体、contextRefsに必要な提示済み参照を書く。",
							parameters: taskParameters(taskChoice),
						},
					},
				]
			: []),
		...(tasks?.works.length
			? [
					{
						type: "function" as const,
						function: {
							name: "task_control",
							description:
								"提示された同じ会話の作業について状態確認、質問への回答、依頼訂正、取消を行う。expectedRevisionは依頼の版。対象が不明なら会話で確認する。終了した作業を復活させない。",
							parameters: taskParameters(controlChoice),
						},
					},
				]
			: []),
		...(allowDiscovery
			? [
					{
						type: "function" as const,
						function: {
							name: DISCOVERY_FUNCTION,
							description:
								"提示された使用済みの担当では今回の用途を満たせず、別の担当が必要なときだけ呼びます。検索は一度だけ、最大4候補です。今回の依頼と参考文脈から用途の検索文を作ります。実行は行いません。",
							parameters: jsonSchema(discoveryChoice),
						},
					},
				]
			: []),
		...cards
			.filter((card) => card.functionName !== tasks?.card?.functionName)
			.map((card) => ({
				type: "function" as const,
				function: {
					name: card.functionName,
					description:
						toolchainDescription(
							card,
							offered,
							sessions.has(card.functionName),
						) +
						(card.instant
							? "。この担当へ任せるときに呼び、依頼の分析と引数を書きます"
							: "。この担当へ任せるときに呼び、予告(announcement)と依頼の分析だけを書きます"),
					parameters: card.instant
						? instantParameters(card.instant.parameters)
						: jsonSchema(toolchainChoice.strict()),
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
				description: `提示された情報では今回の依頼を進められないときに呼びます。必須の対象・条件が曖昧なら短く確認し、候補が適合しなければ不足を伝えます。replyがそのまま回答として音声で読み上げられるため、音声整形後の合計${SPOKEN_REPLY_MAX_CHARS}字以内・${SPOKEN_REPLY_MAX_SENTENCES}文以内にします。担当は起動しません。`,
				parameters: jsonSchema(unavailableChoice.strict()),
			},
		},
	];
	if (!approvalReference)
		for (const tool of tools) {
			const properties = tool.function.parameters.properties as Record<
				string,
				unknown
			>;
			properties.approved = { type: "boolean", const: false };
		}
	return tools;
}

/** The analysis and an instant toolchain's own arguments, in the one flat object the call takes. */
function instantParameters(own: Record<string, unknown>) {
	const analysis = jsonSchema(requestAnalysis.strict());
	const required = (schema: Record<string, unknown>) =>
		Array.isArray(schema.required) ? (schema.required as string[]) : [];
	return {
		...analysis,
		properties: {
			...(analysis.properties as Record<string, unknown>),
			...(own.properties as Record<string, unknown>),
		},
		required: [...required(analysis), ...required(own)],
		additionalProperties: false,
	};
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
	allowDiscovery = false,
	tasks?: TaskOffer,
): FirstRound {
	if (calls.length !== 1)
		throw operationRejection("call_count", undefined, [], calls.length);
	const call = calls[0]!;
	const card = cards.find((c) => c.functionName === call.name);
	if (
		!card &&
		call.name !== ANSWER_FUNCTION &&
		call.name !== UNAVAILABLE_FUNCTION &&
		!(allowDiscovery && call.name === DISCOVERY_FUNCTION) &&
		!(tasks?.card?.functionName === call.name) &&
		!(tasks?.works.length && call.name === "task_control")
	)
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
	if (card?.instant) return validateInstant(call, card as InstantCard, args);
	if (tasks?.card?.functionName === call.name) {
		const parsed = taskChoice.safeParse(args);
		if (
			!parsed.success ||
			parsed.data.contextRefs.some(
				(ref) => !tasks.references.some((r) => r.ref === ref),
			)
		)
			throw operationRejection("arguments_invalid", call);
		return { ...parsed.data, next: "execute_task", card: tasks.card };
	}
	if (call.name === "task_control" && tasks?.works.length) {
		const parsed = controlChoice.safeParse(args);
		if (!parsed.success) throw operationRejection("arguments_invalid", call);
		const {
			workRef,
			expectedRevision,
			action,
			questionRef,
			input,
			request,
			announcement,
			...analysis
		} = parsed.data;
		const work = tasks.works.find(
			(w) => w.id === workRef && w.revision === expectedRevision,
		);
		if (
			!work ||
			(action === "answer" &&
				(!work.question || work.question.id !== questionRef)) ||
			(action === "amend" && !request)
		)
			throw operationRejection("arguments_invalid", call);
		return {
			...analysis,
			next: "task_control",
			announcement,
			control: {
				workRef,
				expectedRevision,
				action,
				questionRef,
				input,
				request,
			},
		};
	}
	const schema = card
		? toolchainChoice.strict()
		: call.name === ANSWER_FUNCTION
			? requestAnalysis
			: call.name === DISCOVERY_FUNCTION
				? discoveryChoice
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
		query?: string;
	};
	const { announcement, reply, query, ...analysis } = data;
	const round: FirstRound = card
		? { ...analysis, next: "toolchain", card, announcement: announcement! }
		: call.name === ANSWER_FUNCTION
			? { ...analysis, next: "answer" }
			: call.name === DISCOVERY_FUNCTION
				? { ...analysis, next: "find_toolchain", query: query! }
				: { ...analysis, next: "report_unavailable", reply: reply! };
	consistent(round);
	return round;
}

/**
 * The call of an instant toolchain: the four values of the analysis, and nothing but the arguments the card
 * declares. Whatever the card does not accept goes back for the structural repair.
 */
function validateInstant(
	call: NativeToolCall,
	card: InstantCard,
	args: unknown,
): FirstRound {
	const record =
		args && typeof args === "object" && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: undefined;
	if (!record)
		throw operationRejection("arguments_invalid", call, [
			{ validationPath: "arguments", validationCode: "invalid_type" },
		]);
	const keys = Object.keys(requestAnalysis.shape);
	const analysis = requestAnalysis.safeParse(
		Object.fromEntries(
			keys.filter((k) => k in record).map((k) => [k, record[k]]),
		),
	);
	if (!analysis.success)
		throw operationRejection(
			"arguments_invalid",
			call,
			validationIssues(analysis.error, args),
		);
	const own = card.instant.parse(
		Object.fromEntries(
			Object.entries(record).filter(([k]) => !keys.includes(k)),
		),
	);
	if (!own.ok)
		throw operationRejection("arguments_invalid", call, [
			{ validationPath: "arguments", validationCode: "invalid_value" },
		]);
	const round: FirstRound = {
		...analysis.data,
		next: "instant",
		card,
		arguments: own.value,
	};
	consistent(round);
	return round;
}

/** The judgment of the first round as the selection trace keeps it (never the request itself). */
export function analysisTrace(round: FirstRound): SelectionAnalysis {
	if (round.next === "find_toolchain")
		throw new Error("discovery_not_selection");
	const { kind, freshness, next, impact, approved } = round;
	// An instant toolchain is handed the request like any other toolchain.
	return {
		kind,
		freshness,
		next:
			next === "instant" || next === "execute_task" || next === "task_control"
				? "toolchain"
				: next,
		impact,
		approved,
	};
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
