import { useState } from "react";
import {
	keepPreviousData,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { TodoResource } from "@eumenes/artifact-ui";
import { workQuery } from "../../../../api/domains/agent-runtime/contracts";
import { agencyWorkPageSchema } from "../../../../client/agent-runtime";
import { queryRoots } from "../../queryKeys";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";

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
		const [query, setQuery] = useState(() =>
			workQuery.parse({ state: "active" }),
		);
		const view = query.state === "archived" ? "archived" : "active";
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
					page: agencyWorkPageSchema.parse(response.data),
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
				rows: read.isPlaceholderData || read.isError ? [] : (page?.rows ?? []),
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
						setQuery({ ...query, state: event.values.view, pageIndex: 0 });
					}
					return { status: "accepted", message: "" };
				}
				if (event.action === "todo-page") {
					const next = workQuery.safeParse({
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
			settled: () => {},
			refresh: () => {
				void read.refetch();
			},
		};
	},
};
