import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "../Collapsible";
import { Button } from "../Button";
import { Badge } from "../Badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../Tabs";
import "./ComputeWorkspace.css";

export type ComputeJob = {
	id: string;
	state: string;
	stage: string | null;
	code: string;
	cancelRequested: boolean;
	progress: { message: string; ratio?: number } | null;
	result: {
		value: unknown;
		stdout: string;
		stderr: string;
		stdoutTruncated: boolean;
		stderrTruncated: boolean;
	} | null;
	error: { code: string; message?: string } | null;
	artifactError: string | null;
	artifacts: Array<{
		id: string;
		name: string;
		mime: string;
		bytes: number;
		ready: boolean;
		url?: string;
	}>;
};
export type ComputeWorkspaceProps = {
	jobs: ComputeJob[];
	available: boolean;
	selectedJobId?: string;
	initialTab?: "result" | "history";
	pending?: boolean;
	message?: string;
	onCancel: (id: string) => void;
	onReconcile: (id: string) => void;
	onRefresh: () => void;
	onDownload: (jobId: string, artifactId: string, name: string) => void;
};
const labels: Record<string, string> = {
	submitting: "送信中",
	queued: "待機中",
	running: "実行中",
	collecting: "成果物を取得中",
	completed: "完了",
	failed: "失敗",
	cancelled: "取消済み",
	indeterminate: "状態の確認が必要",
	deleted: "削除済み",
};
export function ComputeWorkspace({
	jobs,
	available,
	selectedJobId,
	initialTab = "result",
	pending,
	message,
	onCancel,
	onReconcile,
	onRefresh,
	onDownload,
}: ComputeWorkspaceProps) {
	const [tab, setTab] = useState<string>(initialTab);
	const [selected, setSelected] = useState<string | undefined>(selectedJobId);
	const job = jobs.find((j) => j.id === selected) ?? jobs[0];
	return (
		<section className="compute-workspace" aria-label="計算">
			<header>
				<h2>計算</h2>
				<Button variant="outline" onClick={onRefresh} disabled={pending}>
					更新
				</Button>
			</header>
			{!available && (
				<p role="status">
					計算サービスを利用できません。保存済みの結果を表示しています。
				</p>
			)}
			{message && <p role="status">{message}</p>}
			<Tabs value={tab} onValueChange={setTab}>
				<TabsList aria-label="計算の表示">
					<TabsTrigger value="result">計算結果</TabsTrigger>
					<TabsTrigger value="history">ライブラリ</TabsTrigger>
				</TabsList>
				<TabsContent value="result">
					{!job && (
						<p>計算の履歴はありません。チャットから計算を依頼してください。</p>
					)}
					{job && (
						<article key={job.id}>
							<div className="compute-workspace-status" aria-label="計算の状態">
								<Badge
									variant={
										job.state === "completed"
											? "success"
											: job.state === "failed"
												? "destructive"
												: "secondary"
									}
								>
									{labels[job.state] ?? job.state}
								</Badge>
								<span title={job.id} aria-label={`計算ID ${job.id}`}>
									{job.id.slice(0, 8)}
								</span>
							</div>
							{job.cancelRequested &&
								["submitting", "queued", "running", "indeterminate"].includes(
									job.state,
								) && (
									<p role="status">
										取消を要求しました。停止を確認しています。
									</p>
								)}
							{job.progress && (
								<div role="status">
									<p>{job.progress.message}</p>
									{job.progress.ratio !== undefined && (
										<progress
											max={1}
											value={job.progress.ratio}
											aria-label="計算の進捗"
										/>
									)}
								</div>
							)}
							{["submitting", "queued", "running"].includes(job.state) && (
								<Button
									onClick={() => onCancel(job.id)}
									disabled={pending || job.cancelRequested}
								>
									計算を取り消す
								</Button>
							)}
							{job.state === "indeterminate" && (
								<Button onClick={() => onReconcile(job.id)} disabled={pending}>
									同じ計算の状態を再確認
								</Button>
							)}
							<Collapsible className="compute-workspace-accordion">
								<h3>
									<CollapsibleTrigger className="compute-workspace-trigger">
										実行したPythonコード
										<ChevronDown aria-hidden="true" />
									</CollapsibleTrigger>
								</h3>
								<CollapsibleContent className="compute-workspace-content">
									<pre>{job.code}</pre>
								</CollapsibleContent>
							</Collapsible>
							<Collapsible defaultOpen className="compute-workspace-accordion">
								<h3>
									<CollapsibleTrigger className="compute-workspace-trigger">
										結果
										<ChevronDown aria-hidden="true" />
									</CollapsibleTrigger>
								</h3>
								<CollapsibleContent className="compute-workspace-content">
									{job.error && (
										<div role="alert">
											<p>計算エラー: {job.error.code}</p>
											{job.error.message && <pre>{job.error.message}</pre>}
										</div>
									)}
									{job.result && (
										<>
											<pre>{JSON.stringify(job.result.value, null, 2)}</pre>
											{job.result.stdout && (
												<details>
													<summary>
														標準出力
														{job.result.stdoutTruncated ? "（省略あり）" : ""}
													</summary>
													<pre>{job.result.stdout}</pre>
												</details>
											)}
											{job.result.stderr && (
												<details>
													<summary>
														標準エラー
														{job.result.stderrTruncated ? "（省略あり）" : ""}
													</summary>
													<pre>{job.result.stderr}</pre>
												</details>
											)}
										</>
									)}
									{job.artifactError && (
										<p role="alert">成果物の取得エラー: {job.artifactError}</p>
									)}
									{job.artifacts.map((a) => (
										<figure key={a.id}>
											{a.mime === "image/png" && a.url && (
												<img src={a.url} alt={a.name} />
											)}
											<figcaption>
												{a.name} ({a.bytes.toLocaleString()} bytes)
											</figcaption>
											<Button
												variant="outline"
												disabled={!a.ready || pending}
												onClick={() => onDownload(job.id, a.id, a.name)}
											>
												ダウンロード
											</Button>
										</figure>
									))}
								</CollapsibleContent>
							</Collapsible>
						</article>
					)}
				</TabsContent>
				<TabsContent value="history">
					<div className="compute-workspace-library">
						<table>
							<caption>計算履歴 {jobs.length}件</caption>
							<thead>
								<tr>
									<th scope="col">計算</th>
									<th scope="col">状態</th>
									<th scope="col">成果物</th>
									<th scope="col">操作</th>
								</tr>
							</thead>
							<tbody>
								{jobs.map((j) => (
									<tr key={j.id} data-selected={j.id === job?.id || undefined}>
										<th scope="row">計算 {j.id.slice(0, 8)}</th>
										<td>{labels[j.state] ?? j.state}</td>
										<td>{j.artifacts.length}件</td>
										<td>
											<Button
												variant="outline"
												size="sm"
												aria-label={`計算 ${j.id.slice(0, 8)}を開く`}
												onClick={() => {
													setSelected(j.id);
													setTab("result");
												}}
											>
												開く
											</Button>
										</td>
									</tr>
								))}
								{!jobs.length && (
									<tr>
										<td colSpan={4}>計算の履歴はありません。</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</TabsContent>
			</Tabs>
		</section>
	);
}
