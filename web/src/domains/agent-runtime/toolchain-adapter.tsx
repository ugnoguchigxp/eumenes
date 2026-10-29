import { useState } from "react";
import {
	keepPreviousData,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { TodoResource } from "@eumenes/artifact-ui";
import {
	todoPageSchema,
	todoQuery,
	type TodoPage,
} from "../../../../api/domains/agent-runtime/contracts";
import { queryRoots } from "../../queryKeys";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";

const outcomeLabels: Record<
	NonNullable<TodoPage["rows"][number]["outcome"]>,
	string
> = {
	succeeded: "完了",
	partial: "一部のみ",
	failed: "失敗",
	cancelled: "取消",
	interrupted: "中断",
};
/** A ledger row as the table shows it: the whole request, its state, and its outcome with the result summary. */
function rowOf(
	row: TodoPage["rows"][number],
): TodoResource["page"]["rows"][number] {
	const note = [
		row.status === "waiting" ? "確認待ち" : undefined,
		row.outcome ? outcomeLabels[row.outcome] : undefined,
		row.summary ?? undefined,
	].filter(Boolean);
	return {
		id: row.id,
		request: row.request,
		state: row.archived ? "archived" : "todo",
		pipeline: row.pipeline,
		resultSummary: note.length ? note.join("：") : null,
	};
}

/** Registration owns the entry, definition and permitted events; these are only source reads. */
export const todosWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:task-execution@1",
	useArtifact({
		client,
		artifact,
		artifactRevisionId,
		conversationId = "main",
		visible,
	}) {
		const source = artifact.sourceBindings[0]!.source;
		const cache = useQueryClient();
		const [activeQuery, setQuery] = useState(() =>
			todoQuery.parse({ state: "active" }),
		);
		const [view, setView] = useState<"active" | "archived">("active");
		const query =
			view === "archived"
				? todoQuery.parse({ state: "archived", pageIndex: 0, pageSize: 20 })
				: activeQuery;
		const queryKey = [
			queryRoots.agentTasks,
			client.identity,
			artifactRevisionId,
			source,
			conversationId,
			query,
		];
		const read = useQuery({
			queryKey,
			queryFn: async ({ signal }) => {
				const response = await client.toolchainArtifactSource(
					artifactRevisionId,
					source,
					undefined,
					signal,
					{ conversationId, ...query },
				);
				return {
					conversationId,
					revision: response.revision,
					page: todoPageSchema.parse(response.data),
				};
			},
			enabled: visible,
			retry: false,
			placeholderData: keepPreviousData,
		});
		const page =
			read.data?.conversationId === conversationId ? read.data.page : undefined;
		const resource: TodoResource = {
			kind: "todo-workspace",
			revision: read.data?.revision ?? 0,
			view,
			page: {
				rows:
					read.isPlaceholderData || read.isError
						? []
						: (page?.rows ?? []).map(rowOf),
				total: page?.state === view ? page.total : 0,
				pageIndex:
					!read.isPlaceholderData && page ? page.pageIndex : query.pageIndex,
				pageSize: query.pageSize,
				busy: read.isFetching,
				error: read.isError
					? "TODOを取得できませんでした。更新ボタンで再試行してください。"
					: undefined,
			},
			counts: page?.counts,
			busy: read.isFetching,
		};
		return {
			phase: { kind: "ready" },
			snapshot: { [source]: resource },
			targetOf: () => undefined,
			async local(binding, event) {
				if (event.source !== source || binding.source !== source)
					return { status: "rejected", message: "利用できない操作です。" };
				if (event.action === "todo-refresh") {
					await read.refetch();
					return { status: "accepted", message: "" };
				}
				if (
					event.action === "todo-view" &&
					(event.values.view === "active" || event.values.view === "archived")
				) {
					if (event.values.view !== view) {
						await cache.cancelQueries({ queryKey, exact: true });
						setView(event.values.view);
					}
					return { status: "accepted", message: "" };
				}
				if (event.action === "todo-page" && view === "active") {
					const next = todoQuery.safeParse({
						state: view,
						pageIndex: event.values.pageIndex,
						pageSize: event.values.pageSize,
					});
					if (next.success) {
						setQuery(next.data);
						return { status: "accepted", message: "" };
					}
				}
				return { status: "rejected", message: "表示条件を確認してください。" };
			},
			// An archive was accepted: the page reads the ledger again.
			settled: () => {
				void read.refetch();
			},
			refresh: () => {
				if (visible) void read.refetch();
			},
		};
	},
};
