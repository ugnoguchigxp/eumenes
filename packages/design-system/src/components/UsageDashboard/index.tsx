import { useId, useState } from "react";
import { Activity, AudioLines, Coins, Database, RefreshCw } from "lucide-react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../Tabs";
import { UsageTables } from "./UsageTables";
import { Chart } from "../Chart";
import { RatePanel } from "./RatePanel";
import { UsageSelect, token, duration, money, stamp } from "./controls";
import type { UsageDashboardProps, UsageQuery } from "./types";
import "./style.css";
export type * from "./types";

const localDay = (n: number) =>
	new Date(n + 9 * 3600000).toISOString().slice(0, 10);
export function UsageDashboard({
	data,
	busy,
	message,
	title = "利用状況",
	onQuery,
	onRefresh,
	onRateSave,
}: UsageDashboardProps) {
	const fieldId = useId();
	const [tab, setTab] = useState("overview");
	const [metric, setMetric] = useState("seconds");
	const q = data.query,
		s = data.summary;
	const patch = (p: Partial<UsageQuery>) =>
		onQuery({ ...q, pageIndex: 0, ...p });
	function period(days: number | null) {
		const end = localDay(Date.now());
		const start =
			days === null
				? end.slice(0, 8) + "01"
				: localDay(Date.now() - (days - 1) * 86400000);
		patch({ start, end });
	}
	function switchTab(next: string) {
		setTab(next);
		if (next === "rates") return;
		const service =
			next === "live" ? "live" : next === "codex" ? "codex" : "all";
		patch({ service, model: next === "codex" ? data.currentCodexModel : "" });
	}
	const values = data.daily.map((d) =>
		metric === "seconds"
			? d.seconds
			: metric === "tokens"
				? d.inputTokens === null && d.outputTokens === null
					? null
					: (d.inputTokens ?? 0) + (d.outputTokens ?? 0)
				: d.estimate === null
					? null
					: Number(d.estimate),
	);
	return (
		<section className="ds-usage" aria-label={title}>
			<header className="ds-usage-header">
				<div>
					<h2>{title}</h2>
					<p>Eumenes経由の利用 · 開始日で集計 · 日本時間</p>
				</div>
				<Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}>
					<RefreshCw size={14} />
					更新
				</Button>
			</header>
			<div className="ds-usage-toolbar">
				<div className="ds-usage-period" aria-label="期間">
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => period(1)}
					>
						今日
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => period(7)}
					>
						7日間
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => period(null)}
					>
						今月
					</Button>
				</div>
				<label htmlFor={fieldId + "-start"}>
					<span>開始日</span>
					<Input
						id={fieldId + "-start"}
						aria-label="開始日"
						type="date"
						value={q.start}
						max={q.end}
						disabled={busy}
						onChange={(e) => e.target.value && patch({ start: e.target.value })}
					/>
				</label>
				<label htmlFor={fieldId + "-end"}>
					<span>終了日</span>
					<Input
						id={fieldId + "-end"}
						aria-label="終了日"
						type="date"
						value={q.end}
						min={q.start}
						disabled={busy}
						onChange={(e) => e.target.value && patch({ end: e.target.value })}
					/>
				</label>
				<UsageSelect
					label="モデル"
					value={q.model}
					disabled={busy}
					options={[
						{ value: "", label: "すべてのモデル" },
						...data.models.map((m) => ({ value: m, label: m })),
					]}
					onChange={(model) => patch({ model })}
				/>
				<UsageSelect
					label="接続"
					value={q.connectionId}
					disabled={busy}
					options={[
						{ value: "", label: "すべての接続" },
						...data.connections.map((c) => ({ value: c.id, label: c.name })),
					]}
					onChange={(connectionId) => patch({ connectionId })}
				/>
			</div>
			{!!data.ongoing?.length && (
				<p className="ds-usage-message">
					Live接続中 {data.ongoing.length}件 · この期間外{" "}
					{data.ongoing.filter((r) => r.outsidePeriod).length}
					件。期間外の接続は下の小計に含みません。時間は受信済みのAPI報告値です。
				</p>
			)}
			{message && (
				<p role="status" className="ds-usage-message">
					{message}
				</p>
			)}
			<Tabs value={tab} onValueChange={switchTab}>
				<TabsList aria-label="利用状況の種類" className="ds-usage-tabs">
					{[
						["overview", "概要"],
						["live", "Live"],
						["codex", "Codex SDK"],
						["rates", "料金設定"],
					].map(([value, label]) => (
						<TabsTrigger key={value} value={value!} disabled={busy}>
							{label}
						</TabsTrigger>
					))}
				</TabsList>
				{["overview", "live", "codex"].map((view) => (
					<TabsContent key={view} value={view}>
						<div className="ds-usage-cards">
							{view !== "codex" && (
								<>
									<article>
										<AudioLines size={20} />
										<h3>Live 接続時間</h3>
										<strong>{duration(s.seconds)}</strong>
										<small>API報告済み · {s.liveCount}件（試用も含む）</small>
									</article>
									<article>
										<Coins size={20} />
										<h3>Live 概算費用</h3>
										<strong>{money(s.estimate)}</strong>
										<small>
											登録単価で換算 · 単価未設定・欠測 {s.unpriced}件
										</small>
									</article>
								</>
							)}
							{view !== "live" && (
								<>
									<article>
										<Activity size={20} />
										<h3>Codex SDK</h3>
										<strong>
											{s.inputTokens === null && s.outputTokens === null
												? "未取得"
												: token((s.inputTokens ?? 0) + (s.outputTokens ?? 0)) +
													" token"}
										</strong>
										<small>
											入力 {token(s.inputTokens)} / 出力 {token(s.outputTokens)}{" "}
											· {s.codexCount}回
										</small>
									</article>
									<article>
										<Database size={20} />
										<h3>キャッシュ読取</h3>
										<strong>
											{token(s.cacheReadTokens)}
											{s.cacheReadTokens === null ? "" : " token"}
										</strong>
										<small>
											入力の内訳 · キャッシュ量未取得 {s.cacheMissing}件
										</small>
									</article>
								</>
							)}
						</div>
						<div className="ds-usage-section">
							<div className="ds-usage-section-heading">
								<h3>日別の利用</h3>
								<UsageSelect
									label="指標"
									value={metric}
									options={[
										{ value: "seconds", label: "Live 時間" },
										{ value: "tokens", label: "SDK token" },
										{ value: "estimate", label: "Live 概算USD" },
									]}
									onChange={setMetric}
								/>
							</div>
							{values.some((v) => v !== null) ? (
								<Chart
									kind="bar"
									series={[
										{
											name:
												metric === "seconds"
													? "秒"
													: metric === "tokens"
														? "token"
														: "概算USD",
											points: data.daily.flatMap((d, i) =>
												values[i] === null
													? []
													: [{ x: d.date.slice(5), y: values[i]! }],
											),
										},
									]}
									note="既知の利用量の小計。欠測を含む日は全量ではありません。"
								/>
							) : (
								<p className="ds-usage-empty">
									この期間の利用量はまだ記録されていません。
								</p>
							)}
						</div>
						<UsageTables data={data} busy={busy} onQuery={onQuery} />
					</TabsContent>
				))}
				<TabsContent value="rates">
					<RatePanel data={data} busy={busy} onRateSave={onRateSave} />
				</TabsContent>
			</Tabs>
			<footer className="ds-usage-footer">
				<span>
					利用量未取得 {s.missing}件 · 最終量未確認 {s.unconfirmed}件 · 更新中{" "}
					{s.active}件
				</span>
				<span>最終更新 {stamp(data.asOf)}</span>
			</footer>
			<p className="ds-usage-muted">
				概算は請求額ではありません。過去の未保存データ・他アプリの利用・契約残量は含みません。失敗・取消・試用も保存済みの量を集計します。
			</p>
		</section>
	);
}
