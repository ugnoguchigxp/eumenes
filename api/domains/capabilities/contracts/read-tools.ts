import { z } from "zod";

/**
 * The conversation's read tools (spec conversation-read-tools-design 2026-10-31): the host reads its own records for
 * the conversation agent, with no sub-agent and no bundle. Each is a native tool of the talk call, and its search
 * texts are indexed with the toolchains (key `host:<name>@<revision>`), so a request turn's search can offer it.
 * Change a tool's texts with a new revision: the index then embeds them again.
 */
export const readToolInputs = {
	read_memory: z
		.object({
			query: z
				.string()
				.trim()
				.min(1)
				.max(60)
				.optional()
				.describe(
					"確かめたいことを、記録に出てきそうな短い語で書く（例: 辛いもの、住んでいる場所）。本人について全体を聞かれたときは書かない。",
				),
		})
		.strict(),
	read_history: z
		.object({
			query: z
				.string()
				.trim()
				.min(1)
				.max(100)
				.optional()
				.describe(
					"探す語。発言の中にそのまま現れる短い語（例: 旅行、集合時刻）。",
				),
			from: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					"この日時以降の発言。「今」の行から解いた日時（例: 2026-10-30T00:00:00+09:00）。",
				),
			until: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe("この日時より前の発言。from と同じ形。"),
			speaker: z
				.enum(["user", "assistant"])
				.optional()
				.describe("話し手。user は利用者、assistant は Eumenes。"),
		})
		.strict()
		.refine(
			(v) => !v.from || !v.until || Date.parse(v.from) < Date.parse(v.until),
		),
	read_runs: z
		.object({
			count: z
				.number()
				.int()
				.min(1)
				.max(5)
				.optional()
				.describe("何回前まで見るか（1〜5、書かなければ1）。"),
		})
		.strict(),
	read_agents: z
		.object({
			count: z
				.number()
				.int()
				.min(1)
				.max(3)
				.optional()
				.describe("何件前まで見るか（1〜3、書かなければ1）。"),
		})
		.strict(),
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
		revision: 1,
		title: "記憶の確認",
		subject: "記憶",
		description:
			"覚えている記録（本人の好み・事実・習慣）を確かめる。query に確かめたい語。本人について全体を聞かれたら query を書かない。",
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
		revision: 1,
		title: "会話ログの確認",
		subject: "会話ログ",
		description:
			"この会話で誰がいつ何を言ったかを、保存済みの発言から確かめる。query に探す語、from・until に時間（「今」から解いた日時）、speaker に話し手。要るものだけ書く。",
		useWhen: [
			"「会話ログを確認して」「会話履歴を見せて」と、保存されている会話の記録を確かめたい",
			"「さっき何て言った？」と、自分や相手が前に言ったことを確かめたい",
			"「昨日決めた予定は何だっけ」と、以前の会話で決めたこと・話したことを思い出したい",
		],
		examples: [
			"会話ログを確認して",
			"最近の会話履歴を見せて",
			"さっき何て言った？",
			"昨日おすすめしてくれた本は何だっけ",
			"今朝の会話ログをチェックして",
			"前回の会話で決めたことを確認して",
		],
	},
	{
		name: "read_runs",
		revision: 1,
		title: "実行の記録の確認",
		subject: "最近の回",
		description:
			"最近の依頼がどう扱われたか（会話として答えたか、どの担当を選んだか、成功・失敗とその理由）を確かめる。count に何回前まで見るか。",
		useWhen: [
			"「さっきの依頼はなぜ失敗したの？」と、依頼の結果や失敗の理由を確かめたい",
			"「なんで調べてくれなかったの？」と、依頼がどう扱われたかを確かめたい",
			"「実行ログを見て」と、最近の実行の記録を確かめたい",
		],
		examples: [
			"実行ログを確認して",
			"さっきのタイマーはなんで失敗したの？",
			"今の依頼、どの担当に頼んだの？",
			"なんで記憶を見てくれなかったの？",
			"最近のエラーを確認して",
		],
	},
	{
		name: "read_agents",
		revision: 1,
		title: "担当の作業の記録の確認",
		subject: "担当の作業",
		description:
			"最近の依頼で担当（サブエージェント）が受けた依頼、使った道具、結果を確かめる。count に何件前まで見るか。",
		useWhen: [
			"「担当は何をしたの？」と、担当が受けた依頼や使った道具を確かめたい",
			"「さっきの調べもの、どこを見たの？」と、担当の作業の中身を確かめたい",
			"「サブエージェントの会話を見せて」と、担当とのやりとりを確かめたい",
		],
		examples: [
			"サブエージェントの会話を確認して",
			"画像の担当は何をしたの？",
			"さっきの調べもの、どのページを見た？",
			"担当にどう頼んだか見せて",
			"担当の作業の記録を確認して",
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
	const { $schema: _, ...schema } = z.toJSONSchema(
		readToolInputs[name],
	) as Record<string, unknown>;
	const properties = schema.properties as
		| Record<string, Record<string, unknown>>
		| undefined;
	if (!properties) return schema;
	return {
		...schema,
		properties: Object.fromEntries(
			Object.entries(properties).map(
				([key, { pattern: _pattern, format: _format, ...rest }]) => [key, rest],
			),
		),
	};
}

/** The index key of a read tool's revision (never a capability revision). */
export const readToolRevisionId = (tool: Pick<ReadTool, "name" | "revision">) =>
	`host:${tool.name}@${tool.revision}`;

export const isReadToolName = (name: string): name is ReadToolName =>
	Object.hasOwn(readToolInputs, name);
