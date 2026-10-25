import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import "./ResearchTaskCard.css";
const phases: Record<string, string> = {
	route: "依頼を確認中",
	select: "調べ方を準備中",
	research: "調査中",
	search: "検索中",
	read: "資料を確認中",
	answer: "回答を準備中",
	completed: "完了",
	failed: "調査未完了",
	cancelled: "停止",
	interrupted: "中断",
};
const modes: Record<string, string> = {
	search: "検索して確認",
	candidate: "保存した候補を確認",
	cached: "登録サイトを確認",
	rediscover: "取得先を探し直し中",
};
export function ResearchTaskCard({
	client,
	rootRunId,
	title,
	failureAction,
}: {
	client: EumenesClient;
	rootRunId: string;
	title: string;
	/** Shown once the research has failed and its run is complete (the detail of the failure), given its code. */
	failureAction?: (errorCode: string) => ReactNode;
}) {
	const cache = useQueryClient();
	const tasks = useQuery({
		queryKey: [queryRoots.agentTasks, client.identity, rootRunId],
		queryFn: ({ signal }) => client.agentTasks(rootRunId, signal),
		retry: 0,
	});
	const root = tasks.data?.find((t) => t.kind === "coordinator"),
		child = tasks.data?.find((t) => t.kind === "worker");
	const hasActivity =
		!!root &&
		(!!child ||
			root.reportState !== "none" ||
			!!root.errorCode ||
			["waiting_child", "failed", "interrupted", "cancelled"].includes(
				root.status,
			));
	const selections = useQuery({
		queryKey: [queryRoots.toolchainSelections, client.identity, rootRunId],
		queryFn: ({ signal }) =>
			client.toolchainSelections({ runId: rootRunId, limit: 1 }, signal),
		enabled: hasActivity,
		retry: 0,
	});
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
	if (!root || !hasActivity) return null;
	const toolName = selections.data?.items.find(
		(selection) => selection.decision === "toolchain" && selection.functionName,
	)?.functionName;
	const failed =
		!!root.errorCode && root.errorCode !== "clarification_required";
	const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(
		root.status,
	);
	const phase = terminal
		? root.status === "completed" && failed
			? "failed"
			: root.status
		: root.status === "waiting_child"
			? child?.phase
			: root.phase;
	const data = root.reportState === "available" ? report.data : undefined;
	const candidates =
		data && "candidateResults" in data ? data.candidateResults : undefined;
	const mode = modes[child?.acquisitionMode ?? root.acquisitionMode ?? ""];
	const unavailable =
		["deleted", "expired"].includes(root.reportState) ||
		(report.error instanceof ApiError &&
			[404, 410].includes(report.error.status));
	return (
		<aside className="research-activity" aria-label={`調査: ${title}`}>
			<div className="research-activity-progress">
				<span className="research-activity-marker" aria-hidden="true" />
				<span>調査</span>
				{toolName && <span>使用ツール: {toolName}</span>}
				<output aria-live="polite">
					{data?.coverage === "partial" &&
					!["failed", "cancelled", "interrupted"].includes(phase ?? "")
						? "一部未確認"
						: (phases[phase ?? ""] ?? "調査中")}
				</output>
				{terminal &&
					failed &&
					root.status === "completed" &&
					failureAction?.(root.errorCode!)}
				{!terminal && (
					<button
						type="button"
						className="research-activity-stop"
						disabled={cancel.isPending}
						onClick={() => cancel.mutate()}
					>
						調査を停止
					</button>
				)}
			</div>
			{cancel.isError && <p role="alert">停止できませんでした。</p>}
			{(mode || unavailable || report.isError || data) && (
				<details className="research-activity-details" open>
					<summary>調査の詳細・出典</summary>
					{mode && <p>{mode}</p>}
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
						<div>
							<p>{data.summary}</p>
							{!!candidates?.length && (
								<ul aria-label="見つかった候補">
									{candidates.map((c) => (
										<li key={c.reference}>
											<a href={c.url} target="_blank" rel="noopener noreferrer">
												{c.title || c.url}
											</a>{" "}
											— 本文未確認
										</li>
									))}
								</ul>
							)}
							<ul>
								{data.claims.map((c, i) => (
									<li key={i}>{c.text}</li>
								))}
							</ul>
							{!!data.limitations.length && (
								<p>{data.limitations.join(" / ")}</p>
							)}
							<ul>
								{data.sources
									.filter(
										(s) => !candidates?.some((c) => c.sourceId === s.sourceId),
									)
									.map((s) => (
										<li key={s.sourceId}>
											<a href={s.url} target="_blank" rel="noopener noreferrer">
												{s.title || s.url}
											</a>{" "}
											— {s.basis === "snippet" ? "検索要約のみ" : "本文確認"} /
											取得 {new Date(s.fetchedAt).toLocaleString("ja-JP")}
										</li>
									))}
							</ul>
							<small>
								出典との対応を確認しています。内容の正しさを保証する表示ではありません。
							</small>
						</div>
					)}
				</details>
			)}
		</aside>
	);
}
