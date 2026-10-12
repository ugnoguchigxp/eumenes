import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type {
	Recipe,
	Selection,
} from "../../../../api/domains/toolchain-history/contracts";
import { Button } from "../../design-system";
import { queryRoots } from "../../queryKeys";
import "./style.css";

const decisionLabels: Record<Selection["decision"], string> = {
	toolchain: "ツールチェーンへ依頼",
	answer: "直接回答・確認質問",
	rejected: "出力が契約違反",
};
const outcomeLabels: Record<string, string> = {
	answered: "回答できた",
	partial: "一部回答",
	not_found: "見つからない",
	clarification_required: "確認が必要",
	failed: "失敗",
	cancelled: "取消",
	expired: "期限切れ",
	completed: "完了",
};
const recipeLabels: Record<NonNullable<Selection["recipe"]>, string> = {
	matched: "保存済み手順を利用",
	missed: "保存済み手順なし",
	saved: "手順を保存",
};
const stateLabels: Record<Recipe["state"], string> = {
	active: "有効",
	suspended: "停止中（取得に連続失敗）",
	disabled: "無効",
};
const time = (ms: number | null) =>
	ms === null ? "—" : new Date(ms).toLocaleString("ja-JP");

function SelectionDetail({ item }: { item: Selection }) {
	return (
		<div className="toolchain-detail">
			<dl>
				<dt>runId</dt>
				<dd>
					<code>{item.runId}</code>
				</dd>
				<dt>検索方式</dt>
				<dd>{item.retrieval}</dd>
				{item.request && (
					<>
						<dt>渡した依頼</dt>
						<dd>{item.request}</dd>
					</>
				)}
				{item.taskId && (
					<>
						<dt>サブエージェント</dt>
						<dd>
							<code>{item.taskId}</code>
						</dd>
					</>
				)}
				{item.outcomeCode && (
					<>
						<dt>理由</dt>
						<dd>
							<code>{item.outcomeCode}</code>
						</dd>
					</>
				)}
				<dt>参考にした過去の選択</dt>
				<dd>
					{item.historyRefs.length ? `${item.historyRefs.length}件` : "なし"}
				</dd>
			</dl>
			<table>
				<caption>提示した候補</caption>
				<thead>
					<tr>
						<th>順位</th>
						<th>function</th>
						<th>文字一致</th>
						<th>類似度</th>
						<th>過去の選択</th>
					</tr>
				</thead>
				<tbody>
					{item.candidates.map((c) => (
						<tr
							key={c.revisionId}
							aria-current={c.functionName === item.functionName}
						>
							<td>{c.rank}</td>
							<td>{c.functionName}</td>
							<td>{c.ftsRank ?? "—"}</td>
							<td>{c.similarity ?? "—"}</td>
							<td>{c.fromHistory ? "あり" : "—"}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Selections({ client }: { client: EumenesClient }) {
	const [open, setOpen] = useState<string | null>(null);
	const list = useQuery({
		queryKey: [queryRoots.toolchainHistory, "selections"],
		queryFn: ({ signal }) => client.toolchainSelections({ limit: 50 }, signal),
	});
	if (list.isPending) return <output>読み込み中…</output>;
	if (list.isError)
		return <p role="alert">選択の記録を読み込めませんでした。</p>;
	if (!list.data.items.length)
		return <p className="hint">記録はまだありません。</p>;
	return (
		<ul className="toolchain-list">
			{list.data.items.map((item) => (
				<li key={item.id}>
					<button
						type="button"
						aria-expanded={open === item.id}
						onClick={() => setOpen(open === item.id ? null : item.id)}
					>
						<span>{time(item.createdAt)}</span>
						<strong>
							{item.functionName ?? decisionLabels[item.decision]}
						</strong>
						<span>
							{item.outcome
								? (outcomeLabels[item.outcome] ?? item.outcome)
								: "実行中"}
						</span>
						{item.recipe && <span>{recipeLabels[item.recipe]}</span>}
					</button>
					{open === item.id && <SelectionDetail item={item} />}
				</li>
			))}
		</ul>
	);
}

function Recipes({ client }: { client: EumenesClient }) {
	const cache = useQueryClient();
	const list = useQuery({
		queryKey: [queryRoots.toolchainHistory, "recipes"],
		queryFn: ({ signal }) => client.toolchainRecipes(undefined, signal),
	});
	const refresh = () =>
		cache.invalidateQueries({ queryKey: [queryRoots.toolchainHistory] });
	const setState = useMutation({
		mutationFn: (v: { id: string; state: "active" | "disabled" }) =>
			client.setToolchainRecipeState(v.id, v.state),
		onSettled: refresh,
	});
	const remove = useMutation({
		mutationFn: (id: string) => client.deleteToolchainRecipe(id),
		onSettled: refresh,
	});
	if (list.isPending) return <output>読み込み中…</output>;
	if (list.isError)
		return <p role="alert">保存済みの手順を読み込めませんでした。</p>;
	if (!list.data.items.length)
		return <p className="hint">保存済みの取得手順はありません。</p>;
	const busy = setState.isPending || remove.isPending;
	return (
		<ul className="toolchain-list">
			{list.data.items.map((r) => (
				<li key={r.id} className="toolchain-recipe">
					<div>
						<strong>{r.signature}</strong>
						<span>{stateLabels[r.state]}</span>
					</div>
					<a href={r.url} target="_blank" rel="noreferrer noopener">
						{r.url}
					</a>
					<p className="hint">
						読む箇所: {r.readHint} ／ 成功 {r.successes}回・失敗 {r.failures}回
						／ 最終成功 {time(r.lastSuccessAt)}
					</p>
					<div className="toolchain-actions">
						<Button
							variant="secondary"
							disabled={busy}
							onClick={() =>
								setState.mutate({
									id: r.id,
									state: r.state === "active" ? "disabled" : "active",
								})
							}
						>
							{r.state === "active" ? "無効にする" : "有効にする"}
						</Button>
						<Button
							variant="secondary"
							disabled={busy}
							onClick={() => remove.mutate(r.id)}
						>
							削除
						</Button>
					</div>
				</li>
			))}
		</ul>
	);
}

/** Which toolchain the conversation chose and how it ended, and the saved fetch procedures. */
export function ToolchainHistoryPanel({ client }: { client: EumenesClient }) {
	return (
		<div className="toolchain-panel">
			<section>
				<h3>選択の記録</h3>
				<p className="hint">
					会話がどの候補からどのツールチェーンを選び、どう終わったかの記録です（30日保持）。
				</p>
				<Selections client={client} />
			</section>
			<section>
				<h3>保存済みの取得手順</h3>
				<p className="hint">
					Web検索で同じ依頼を受けたときに取得し直すページです。値は毎回取得し直します。
				</p>
				<Recipes client={client} />
			</section>
		</div>
	);
}
