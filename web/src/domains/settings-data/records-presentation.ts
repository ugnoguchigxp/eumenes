import type { EumenesClient } from "../../../../client";
import type { Usage } from "../../../../client/settings";
import type { RecordRow, SavedProcedure } from "@eumenes/design-system";

export type Selection = Awaited<
	ReturnType<EumenesClient["toolchainSelections"]>
>["items"][number];
export type Recipe = Awaited<
	ReturnType<EumenesClient["toolchainRecipes"]>
>["items"][number];
const time = (ms: number | null) =>
	ms === null ? "—" : new Date(ms).toLocaleString("ja-JP");
const outcomes: Record<string, string> = {
	answered: "回答できた",
	partial: "一部回答",
	not_found: "見つからない",
	clarification_required: "確認が必要",
	failed: "失敗",
	cancelled: "取消",
	expired: "期限切れ",
	completed: "完了",
};
const decisions = {
	toolchain: "ツールチェーンへ依頼",
	answer: "直接回答・確認質問",
	rejected: "出力が契約違反",
};
const recipeLabels = {
	matched: "保存済み手順を利用",
	missed: "保存済み手順なし",
	saved: "手順を保存",
};
export function usageRow(item: Usage): RecordRow {
	return {
		id: item.id,
		label: { llm: "会話", asr: "聞き取り", tts: "読み上げ" }[item.purpose],
		cells: {
			started: time(item.started),
			purpose: { llm: "会話", asr: "聞き取り", tts: "読み上げ" }[item.purpose],
			source: item.source,
			model: item.model,
			status: item.accepted ? "採用済み" : item.status,
		},
		summary: [
			time(item.started),
			`${item.source} / ${item.model}`,
			item.accepted ? "採用済み" : item.status,
		],
		details: [
			{ label: "切替・失敗理由", value: item.reason ?? "—" },
			{
				label: "入力 / 出力トークン",
				value: `${item.inputTokens ?? "不明"} / ${item.outputTokens ?? "不明"}`,
			},
			{
				label: "開始 / 終了",
				value: `${time(item.started)} / ${time(item.ended)}`,
			},
			{ label: "要求ID", value: item.requestId },
		],
	};
}
export function selectionRow(item: Selection): RecordRow {
	return {
		id: item.id,
		label: item.functionName ?? decisions[item.decision],
		cells: {
			createdAt: time(item.createdAt),
			process: item.functionName ?? decisions[item.decision],
			outcome: item.outcome
				? (outcomes[item.outcome] ?? item.outcome)
				: "実行中",
		},
		summary: [
			time(item.createdAt),
			item.outcome ? (outcomes[item.outcome] ?? item.outcome) : "実行中",
			...(item.recipe ? [recipeLabels[item.recipe]] : []),
		],
		details: [
			{ label: "渡した依頼", value: item.request ?? "—" },
			{ label: "検索方式", value: item.retrieval },
			{
				label: "参考にした過去の選択",
				value: item.historyRefs.length
					? `${item.historyRefs.length}件`
					: "なし",
			},
			{ label: "実行ID", value: item.runId },
			{ label: "担当の作業ID", value: item.taskId ?? "—" },
			{ label: "理由", value: item.outcomeCode ?? "—" },
			{
				label: "取得手順の利用",
				value: item.recipe ? recipeLabels[item.recipe] : "—",
			},
		],
		table: {
			title: "提示した候補",
			columns: ["順位", "処理", "文字一致", "類似度", "過去の選択"],
			rows: item.candidates.map((c) => [
				String(c.rank),
				c.functionName,
				String(c.ftsRank ?? "—"),
				String(c.similarity ?? "—"),
				c.fromHistory ? "あり" : "—",
			]),
		},
	};
}
export function procedureRow(item: Recipe): SavedProcedure {
	const url =
		URL.canParse(item.url) &&
		["http:", "https:"].includes(new URL(item.url).protocol)
			? item.url
			: undefined;
	return {
		id: item.id,
		label: item.signature,
		url,
		status: {
			active: "有効",
			suspended: "停止中（取得に連続失敗）",
			disabled: "無効",
		}[item.state],
		enabled: item.state === "active",
		cells: {
			successes: String(item.successes),
			failures: String(item.failures),
			updatedAt: time(item.updatedAt),
		},
		description: `読む箇所: ${item.readHint} ／ 成功 ${item.successes}回・失敗 ${item.failures}回 ／ 最終成功 ${time(item.lastSuccessAt)}`,
	};
}
