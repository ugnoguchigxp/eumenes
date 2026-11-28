import { z } from "zod";

export const scheduleReadTarget = z.strictObject({
	kind: z.enum(["schedule"]),
	id: z.uuid().optional(),
	at: z.iso.datetime({ offset: true }).optional(),
});
export type ScheduleReadTarget = z.infer<typeof scheduleReadTarget>;

/**
 * The conversation's read tools (spec conversation-read-tools-design 2026-10-31): the host reads its own records for
 * the conversation agent, with no sub-agent and no bundle. Each is a native tool of the talk call, and its search
 * texts are indexed with the toolchains (key `host:<name>@<revision>`), so a request turn's search can offer it.
 * Change a tool's texts with a new revision: the index then embeds them again.
 */
export const readToolInputs = {
	read_memory: z
		.object({
			query: z.string().trim().min(1).max(60).optional(),
		})
		.strict(),
	read_history: z
		.object({
			query: z.string().trim().min(1).max(100).optional(),
			from: z.string().datetime({ offset: true }).optional(),
			until: z.string().datetime({ offset: true }).optional(),
			speaker: z.enum(["user", "assistant"]).optional(),
		})
		.strict()
		.refine(
			(v) => !v.from || !v.until || Date.parse(v.from) < Date.parse(v.until),
		),
	read_runs: z
		.object({
			count: z.number().int().min(1).max(5).optional(),
			target: scheduleReadTarget.optional(),
		})
		.strict()
		.refine(
			({ count, target }) => count === undefined || target === undefined,
			{
				path: ["target"],
			},
		),
	read_world: z
		.object({
			names: z
				.array(z.string().trim().min(1).max(60))
				.min(1)
				.max(5)
				.describe("確かめたい対象の名前（1〜5件）。言われた名前のまま書く。"),
		})
		.strict(),
} as const;

export type ReadToolName = keyof typeof readToolInputs;

export type ReadTool = {
	name: ReadToolName;
	revision: number;
	title: string;
	/** What the result heading names (「<subject>の記録です」). */
	subject: string;
	/** What the model reads as the tool's description; the search indexes it after the title. */
	description: string;
	useWhen: string[];
	examples: string[];
};

export const READ_TOOLS: readonly ReadTool[] = [
	{
		name: "read_memory",
		revision: 3,
		title: "記憶の確認",
		subject: "記憶",
		description:
			"「## Memory」に無い、覚えている記録（本人の好み・事実・習慣）を確かめる。query は記録に出てきそうな短い語。本人全体を聞かれたら query なし。",
		useWhen: [
			"「記憶を確認して」「メモリーをチェックして」と、覚えている記録を確かめたい",
			"「私について何を覚えてる？」と、本人について覚えていることを聞いている",
			"「私の好きな食べ物を覚えてる？」と、本人の好み・事実・習慣を覚えているか聞いている",
		],
		examples: [
			"記憶を確認して",
			"メモリーをチェックして",
			"私について覚えていることを教えて",
			"私のことをどれくらい知ってる？",
			"私の好きな食べ物って記憶にある？",
		],
	},
	{
		name: "read_history",
		revision: 3,
		title: "会話ログの確認",
		subject: "会話ログ",
		description:
			"この会話の保存済みの発言から、誰がいつ何を言ったかを確かめる。query は発言に現れる短い語、from・until は「今」から解いた時差付きの日時。",
		useWhen: [
			"「会話ログを確認して」「会話履歴を見せて」と、保存されている会話の記録を確かめたい",
			"この会話でさっき自分が伝えたことや、相手が返した言葉を読み返したい",
			"最近の発言を探し、そこで話した日時、場所、名前などを確かめたい",
		],
		examples: [
			"会話ログを確認して",
			"最近の会話履歴を見せて",
			"さっき何て言った？",
			"昨日おすすめしてくれた本は何だっけ",
			"今朝の会話ログをチェックして",
			"昨夜、私が伝えた受け取り場所を会話の発言から調べて",
		],
	},
	{
		name: "read_runs",
		revision: 4,
		title: "実行の記録の確認",
		subject: "最近の回",
		description:
			'最近の依頼の結果・エラー（count、既定1）か、予約の有無・次回・実行結果（target {"kind":"schedule"}。id・at は分かるときだけ）を確かめる。',
		useWhen: [
			"「さっきの依頼はなぜ失敗したの？」と、依頼の結果や失敗の理由を確かめたい",
			"「なんで調べてくれなかったの？」と、依頼がどう扱われたかを確かめたい",
			"「実行ログを見て」と、最近の実行の記録を確かめたい",
			"Eumenes 自身の予約が登録されたか、予定時刻に動いたか、どこで止まったかを確認したい",
		],
		examples: [
			"実行ログを確認して",
			"依頼が途中で終わった理由を実行ログから教えて",
			"直前の回でどの担当が呼ばれたか、実行記録を確認して",
			"最近のエラーを確認して",
			"この会話の予約は登録されてる？",
			"今朝の実行予約が動いたか確認して",
		],
	},
	{
		name: "read_world",
		revision: 1,
		title: "World の記録の確認",
		subject: "World",
		description:
			"World に記録された対象と主張、取り込んだ資料を確かめる。names に対象の名前。",
		useWhen: [
			"「World だと〜について何が記録されてる？」と、World の記録を確かめたい",
			"「〜について記録されていることを見せて」と、記録された主張を確かめたい",
		],
		examples: [
			"World の記録を確認して",
			"World だと LARM について何が記録されてる？",
			"Eumenes について記録されていることを見せて",
		],
	},
];

/**
 * A read tool's arguments as the model reads them (the talk call's native tool, a candidate's inputs): JSON Schema
 * without `$schema`, nor the date-time `pattern` and `format`, which a provider's grammar may not take. The host checks
 * the arguments against the full validator all the same.
 */
export function readToolParameters(
	name: ReadToolName,
): Record<string, unknown> {
	const { $schema: _, ...schema } = z.toJSONSchema(readToolInputs[name], {
		override: ({ jsonSchema }) => {
			delete jsonSchema.pattern;
			delete jsonSchema.format;
		},
	});
	return schema;
}

/** The index key of a read tool's revision (never a capability revision). */
export const readToolRevisionId = (tool: Pick<ReadTool, "name" | "revision">) =>
	`host:${tool.name}@${tool.revision}`;

export const isReadToolName = (name: string): name is ReadToolName =>
	Object.hasOwn(readToolInputs, name);
