import { z } from "zod";
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import {
	ValidationFailure,
	repairIssues,
	validationIssues,
} from "../../../infrastructure/validation-log";

/**
 * The fixed tools of the conversation agent (the ContextWindow specification, section 6.1): the same set in every
 * generation, so a template that puts tool definitions before the prompt never breaks the cached prefix. No
 * toolchain is named here; candidates come back as the result of the search tool.
 */
export const TOOL_NAMES = {
	memory: "memory",
	search: "find_toolchain",
	delegate: "delegate",
	work: "work",
} as const;
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/*
 * Two forms of each tool's arguments. The host validates every call against the zod schemas below, with every
 * bound and every mode's required fields. The model reads the compact definitions further down: one flat object
 * per tool, ids without length bounds, and only the limits that change what it writes stated in the description.
 */
const id = z.string().trim().min(1).max(160);
const impacts = ["none", "create", "modify_existing", "irreversible"] as const;

export const memoryArgs = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("read"),
			query: z.string().trim().min(1).max(500).optional(),
			itemIds: z.array(id).max(16).optional(),
		})
		.strict(),
	z
		.object({
			operation: z.literal("request"),
			kind: z.enum(["forget", "remember", "correct", "goal", "withdraw"]),
			what: z.string().trim().min(1).max(500),
			detail: z.string().trim().max(1000).optional(),
		})
		.strict(),
]);
export type MemoryArgs = z.infer<typeof memoryArgs>;

export const searchArgs = z
	.object({ query: z.string().trim().min(1).max(2000) })
	.strict();

const announcement = z.string().trim().min(1).max(80);

export const delegateArgs = z.discriminatedUnion("mode", [
	z
		.object({
			mode: z.enum(["execute", "confirm"]),
			toolchain: id,
			request: z.string().trim().min(1).max(8000),
			announcement: announcement.optional(),
			impact: z.enum(impacts),
			inputs: z.record(z.string(), z.unknown()).optional(),
			target: id.optional(),
			resolveUnsaved: z.literal("discard").optional(),
		})
		.strict(),
	z
		.object({
			mode: z.literal("approve"),
			confirmation: id,
			announcement: announcement.optional(),
		})
		.strict(),
]);
export type DelegateArgs = z.infer<typeof delegateArgs>;

export const workArgs = z
	.object({
		todo: id,
		operation: z.enum(["check", "answer", "amend", "cancel"]),
		revision: z.number().int().min(0),
		questionId: id.optional(),
		text: z.string().trim().min(1).max(8000).optional(),
	})
	.strict();
export type WorkArgs = z.infer<typeof workArgs>;

const text = (description: string) => ({ type: "string", description });
const ids = (description: string) => ({
	type: "array",
	items: { type: "string" },
	description,
});
const choice = (values: readonly string[], description: string) => ({
	type: "string",
	enum: values,
	description,
});
const tool = (
	name: ToolName,
	description: string,
	properties: Record<string, unknown>,
	required: string[],
): NativeTool => ({
	type: "function",
	function: {
		name,
		description,
		parameters: { type: "object", properties, required },
	},
});

/** The fixed tool definitions, in a fixed order (the same set in every generation). */
export const generationTools: NativeTool[] = [
	tool(
		TOOL_NAMES.memory,
		"本人の長期記憶を読む（read）か、記憶担当へ依頼する（request）。profileにある項目は読まない。会話の原文はlogか会話履歴の担当で読む。",
		{
			operation: choice(["read", "request"], "readかrequest。"),
			query: text("readで探す内容。"),
			itemIds: ids("readで読み直す項目のid。"),
			kind: choice(
				["forget", "remember", "correct", "goal", "withdraw"],
				"requestの種類。forget=忘れて、remember=覚えて、correct=直して、goal=目標の登録・変更・完了・取下げ、withdraw=未反映の依頼の取下げ。",
			),
			what: text("requestの対象（500字以内）。"),
			detail: text("requestの補足（1000字以内）。"),
		},
		["operation"],
	),
	tool(
		TOOL_NAMES.search,
		"state.retainedで足りないとき、依頼に合う担当の候補（最大4件）を探す。実行しない。1生成1回まで。",
		{
			query: text(
				"最初の一つの作業に必要な担当の用途。対象・時点・条件を保つ。",
			),
		},
		["query"],
	),
	tool(
		TOOL_NAMES.delegate,
		"担当へ仕事を渡す。execute=実行（予告付き。即答の担当は予告なしで答えが返る）、confirm=既存を変える・取り消せない仕事の前に確認文を出す（実行しない）、approve=承認された確認を実行する。",
		{
			mode: choice(["execute", "confirm", "approve"], "方式。"),
			toolchain: text(
				"execute・confirmの担当のid（find_toolchainの結果かstate.retained）。",
			),
			request: text(
				"担当への依頼。明示された対象名・識別子・地域・日時・数値・単位は原文のまま保ち、省略だけ文脈で補う。",
			),
			announcement: text(
				"予告、またはconfirmの確認文（80字以内）。これから行うことを言い、完了は断言しない。",
			),
			impact: choice(
				impacts,
				"依頼の種類ではなく、既存のものへの影響。none=答える・調べる・参照するだけ、create=新しいものを設定・作成するだけで既存を変えない、modify_existing=既存の機能・コード・データ・設定・保存物を変える、irreversible=削除・外部送信・公開など取り消せない。",
			),
			inputs: {
				type: "object",
				description: "即答の担当の引数、またはパイプラインの入力。",
			},
			target: text("専門担当が開く保存済みの対象。"),
			resolveUnsaved: choice(
				["discard"],
				"未保存の作業を捨ててよいと言われたとき。",
			),
			confirmation: text("approveで実行するstate.pendingConfirmationのid。"),
		},
		["mode"],
	),
	tool(
		TOOL_NAMES.work,
		"依頼済みの仕事（state.todos）を確認・回答・訂正・取消する。",
		{
			todo: text("state.todosのid。"),
			operation: choice(
				["check", "answer", "amend", "cancel"],
				"check=状態と結果を読む、answer=質問に答える、amend=依頼を訂正、cancel=取消。",
			),
			revision: { type: "integer", description: "state.todosかactiveの版。" },
			questionId: text("answerで答える質問のid。"),
			text: text(
				"answerの答え（質問が形を求めるならそのJSON）、またはamendの新しい依頼。",
			),
		},
		["todo", "operation", "revision"],
	),
];

export type ParsedCall =
	| { name: "memory"; call: NativeToolCall; args: MemoryArgs }
	| {
			name: "find_toolchain";
			call: NativeToolCall;
			args: z.infer<typeof searchArgs>;
	  }
	| { name: "delegate"; call: NativeToolCall; args: DelegateArgs }
	| { name: "work"; call: NativeToolCall; args: WorkArgs };

const schemas: Record<ToolName, z.ZodType> = {
	memory: memoryArgs,
	find_toolchain: searchArgs,
	delegate: delegateArgs,
	work: workArgs,
};

/** A call the host refuses; the agent reads the reason as the call's result (no arguments or text reach the log). */
export function toolRejection(
	code: string,
	issues: Record<string, unknown>[] = [],
) {
	return new ValidationFailure(
		code,
		issues.length ? issues : [{ reason: code }],
	);
}

/** Checks one call against its tool's schema; an unknown tool or invalid arguments is a structural violation. */
export function parseCall(call: NativeToolCall): ParsedCall {
	const schema = schemas[call.name as ToolName];
	if (!schema)
		throw toolRejection("unknown_tool", [{ reason: "unknown_tool" }]);
	let value: unknown;
	try {
		value = JSON.parse(call.arguments || "{}");
	} catch {
		throw toolRejection("tool_arguments_not_json", [
			{ tool: call.name, reason: "tool_arguments_not_json" },
		]);
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		throw new ValidationFailure(
			"invalid_tool_arguments",
			validationIssues(parsed.error, value, [call.name]),
			undefined,
			repairIssues(parsed.error),
		);
	return { name: call.name, call, args: parsed.data } as ParsedCall;
}
