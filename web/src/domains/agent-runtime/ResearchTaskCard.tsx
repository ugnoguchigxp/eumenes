import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client";
import { queryRoots } from "../../queryKeys";
const phases: Record<string, string> = {
	route: "依頼を確認中",
	select: "調べ方を準備中",
	research: "調査中",
	search: "検索中",
	read: "資料を読取り中",
	answer: "回答を準備中",
	completed: "完了",
	failed: "取得失敗",
	cancelled: "停止",
	interrupted: "中断",
};
export function ResearchTaskCard({
	client,
	rootRunId,
	title,
}: {
	client: EumenesClient;
	rootRunId: string;
	title: string;
}) {
	const cache = useQueryClient();
	const tasks = useQuery({
		queryKey: [queryRoots.agentTasks, client.identity, rootRunId],
		queryFn: ({ signal }) => client.agentTasks(rootRunId, signal),
		retry: 0,
	});
	const root = tasks.data?.find((t) => t.kind === "coordinator"),
		child = tasks.data?.find((t) => t.kind === "worker");
	const report = useQuery({
		queryKey: [queryRoots.agentReports, client.identity, rootRunId],
		queryFn: ({ signal }) => client.agentReport(root!.id, signal),
		enabled:
			!!root &&
			["ready_for_answer", "completed"].includes(root.status) &&
			root.reportState === "available",
		retry: 0,
	});
	const reportState = root?.reportState;
	useEffect(() => {
		if (reportState && ["deleted", "expired"].includes(reportState))
			cache.removeQueries({
				queryKey: [queryRoots.agentReports, client.identity, rootRunId],
				exact: true,
			});
	}, [cache, client.identity, rootRunId, reportState]);
	const cancel = useMutation({
		mutationFn: () => client.cancelAgentTask(root!.id),
		onSuccess: () =>
			cache.invalidateQueries({ queryKey: [queryRoots.agentTasks] }),
	});
	// Ordinary replies do not create a research card.
	if (
		!root ||
		(!child &&
			root.reportState === "none" &&
			!root.errorCode &&
			!["waiting_child", "failed", "interrupted", "cancelled"].includes(
				root.status,
			))
	)
		return null;
	const failed =
		!!root.errorCode && root.errorCode !== "clarification_required";
	const phase =
		root.status === "waiting_child"
			? child?.phase
			: root.status === "completed" && failed
				? "failed"
				: root.phase;
	const data = root.reportState === "available" ? report.data : undefined;
	const unavailable =
		["deleted", "expired"].includes(root.reportState) ||
		(report.error instanceof ApiError &&
			[404, 410].includes(report.error.status));
	return (
		<aside className="research-card" aria-label={`調査: ${title}`}>
			<strong>{title.slice(0, 80)}</strong>
			<output>
				{data?.coverage === "partial" &&
				!["failed", "cancelled", "interrupted"].includes(phase ?? "")
					? "一部未確認"
					: (phases[phase ?? ""] ?? "調査中")}
			</output>
			{!["completed", "failed", "cancelled", "interrupted"].includes(
				root.status,
			) && (
				<button
					type="button"
					disabled={cancel.isPending}
					onClick={() => cancel.mutate()}
				>
					調査を停止
				</button>
			)}
			{cancel.isError && <p>停止できませんでした。</p>}
			{unavailable ? (
				<p>
					{root.reportState === "deleted"
						? "調査の詳細は削除されました。"
						: "詳細の保持期間が終了しました。"}
				</p>
			) : report.isError ? (
				<p>調査結果を読み込めませんでした。</p>
			) : null}
			{data && (
				<details open>
					<summary>調査の要約と出典</summary>
					<p>{data.summary}</p>
					<ul>
						{data.claims.map((c, i) => (
							<li key={i}>{c.text}</li>
						))}
					</ul>
					{!!data.limitations.length && <p>{data.limitations.join(" / ")}</p>}
					<ul>
						{data.sources.map((s) => (
							<li key={s.sourceId}>
								<a href={s.url} target="_blank" rel="noopener noreferrer">
									{s.title || s.url}
								</a>{" "}
								— {s.basis === "snippet" ? "検索要約のみ" : "本文確認"} / 取得{" "}
								{new Date(s.fetchedAt).toLocaleString("ja-JP")}
							</li>
						))}
					</ul>
					<small>
						出典との対応を確認しています。内容の正しさを保証する表示ではありません。
					</small>
				</details>
			)}
			{failed && <p>調査を完了できませんでした。もう一度依頼してください。</p>}
		</aside>
	);
}
