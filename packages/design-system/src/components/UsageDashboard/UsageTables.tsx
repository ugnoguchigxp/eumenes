import { Button } from "../Button";
import { DataTable } from "../DataTable";
import { token, duration, money, stamp } from "./controls";
import type { UsageDashboardData, UsageQuery } from "./types";
const roles: Record<string, string> = {
	main: "主会話",
	subagent: "Sub",
	auxiliary: "補助",
};
const stateLabels: Record<string, string> = {
	active: "接続中",
	connecting: "接続中",
	closing: "終了処理",
	closed: "終了",
	failed: "失敗",
	interrupted: "中断",
	cancelled: "取消",
	succeeded: "成功",
	running: "実行中",
	revoked: "失効",
};
export function UsageTables({
	data,
	busy,
	onQuery,
}: {
	data: UsageDashboardData;
	busy?: boolean;
	onQuery(query: UsageQuery): void;
}) {
	const q = data.query;
	const patch = (p: Partial<UsageQuery>) => onQuery({ ...q, ...p });
	return (
		<>
			{" "}
			<div className="ds-usage-section">
				<DataTable
					title="モデル別の内訳"
					columns={[
						"サービス / 役割",
						"モデル / 接続",
						"回数",
						"利用量",
						"概算費用",
					].map((header) => ({ header }))}
					rows={data.groups.map((g) => [
						g.service === "live"
							? "Live"
							: "SDK / " + (roles[g.role ?? ""] ?? "不明"),
						(g.model ?? "不明・複数モデル") +
							" / " +
							(g.connectionName ?? "不明"),
						g.count,
						g.service === "live"
							? duration(g.seconds)
							: "入力 " +
								token(g.inputTokens) +
								" / 出力 " +
								token(g.outputTokens),
						g.service === "live" ? money(g.estimate) : "トークン集計",
					])}
				/>
			</div>
			<div className="ds-usage-section">
				<DataTable
					title="利用明細"
					columns={[
						"開始日時 / 状態",
						"サービス / モデル",
						"接続 / 役割",
						"利用量",
						"計測",
						"費用の根拠",
					].map((header) => ({ header }))}
					rows={data.rows.map((r) => [
						stamp(r.started) + " / " + (stateLabels[r.status] ?? r.status),
						(r.service === "live" ? "Live" : "SDK") +
							" / " +
							(r.model ?? "不明・複数モデル") +
							(r.model !== r.requestedModel
								? "（要求: " + r.requestedModel + "）"
								: ""),
						(r.connectionName ?? "不明") +
							" / " +
							(r.test ? "試用" : (roles[r.role ?? ""] ?? "通常")),
						r.service === "live"
							? duration(r.seconds)
							: "入力 " +
								token(r.inputTokens) +
								" / 出力 " +
								token(r.outputTokens) +
								" / cache " +
								token(r.cacheReadTokens) +
								" / 書込 " +
								token(r.cacheCreationTokens) +
								" / 推論 " +
								token(r.reasoningTokens),
						r.confirmed ? "API報告済み" : "最終量未確認",
						r.service === "live"
							? money(r.estimate) +
								(r.rateId ? " / 単価 " + r.rateId.slice(0, 8) : "")
							: r.reportedUsd === null
								? "金額未取得"
								: "Provider報告 " + money(r.reportedUsd),
					])}
				/>
				<div className="ds-usage-pager">
					<span>
						{data.total}件 · {q.pageIndex + 1} /{" "}
						{Math.max(1, Math.ceil(data.total / data.pageSize))}ページ
					</span>
					<Button
						size="sm"
						variant="outline"
						disabled={busy || q.pageIndex === 0}
						onClick={() => patch({ pageIndex: q.pageIndex - 1 })}
					>
						前へ
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={busy || (q.pageIndex + 1) * data.pageSize >= data.total}
						onClick={() => patch({ pageIndex: q.pageIndex + 1 })}
					>
						次へ
					</Button>
				</div>
			</div>
		</>
	);
}
