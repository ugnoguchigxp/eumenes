import { usagePageQuerySchema } from "../../../../client/settings";
import {
	selectionPageQuerySchema,
	recipePageQuerySchema,
} from "../../../../client/toolchain-history";
import { useEffect, useLayoutEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactRuntime } from "@eumenes/artifact-ui";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { procedureRow, selectionRow, usageRow } from "./records-presentation";
import { createRecordsSession } from "./records-session";

export function useRecordsRuntime(
	client: EumenesClient,
	enabled: boolean,
): ArtifactRuntime {
	const [session] = useState(() => createRecordsSession(client));
	const cache = useQueryClient();
	useEffect(() => {
		session.mount();
		return () => session.dispose();
	}, [session]);
	const [queries, setQueries] = useState({
		ai: usagePageQuerySchema.parse({}),
		toolchains: selectionPageQuerySchema.parse({}),
		procedures: recipePageQuerySchema.parse({}),
	});
	const usage = useQuery({
		queryKey: [queryRoots.inferenceUsage, client.identity, "page", queries.ai],
		queryFn: ({ signal }) => client.inferenceUsagePage(queries.ai, signal),
		enabled,
		retry: false,
	});
	const selections = useQuery({
		queryKey: [
			queryRoots.toolchainHistory,
			client.identity,
			"record-selections",
			queries.toolchains,
		],
		queryFn: ({ signal }) =>
			client.toolchainSelectionsPage(queries.toolchains, signal),
		enabled,
		retry: false,
	});
	const recipes = useQuery({
		queryKey: [
			queryRoots.toolchainHistory,
			client.identity,
			"record-recipes",
			queries.procedures,
		],
		queryFn: ({ signal }) =>
			client.toolchainRecipesPage(queries.procedures, signal),
		enabled,
		retry: false,
	});
	const diagnostics = useQuery({
		queryKey: [queryRoots.settingsDiagnostics, client.identity],
		queryFn: () => client.settingsDiagnostics(),
		enabled,
		retry: false,
	});
	const observed = [
		queries,
		usage.data,
		usage.isFetching,
		usage.isError,
		selections.data,
		selections.isFetching,
		selections.isError,
		recipes.data,
		recipes.isFetching,
		recipes.isError,
		diagnostics.data,
		diagnostics.isFetching,
		diagnostics.isError,
	];
	const [version, setVersion] = useState({ observed, revision: 0 });
	if (observed.some((value, index) => value !== version.observed[index]))
		setVersion({ observed, revision: version.revision + 1 });
	const revision = version.revision;
	useLayoutEffect(() => {
		session.bind({
			revision,
			recipes: recipes.data?.items ?? [],
			query: (tableId, query) =>
				setQueries((old) => ({ ...old, [tableId]: query })),
			refresh: async () => {
				const results = await Promise.all([
					usage.refetch(),
					selections.refetch(),
					recipes.refetch(),
					diagnostics.refetch(),
				]);
				if (results.some((result) => result.isError))
					throw new Error("refresh_failed");
			},
			refreshRecipes: async () => {
				await cache.invalidateQueries({
					queryKey: [queryRoots.toolchainHistory],
					refetchType: "none",
				});
				const result = await recipes.refetch();
				if (result.isError) throw new Error("refresh_failed");
			},
		});
	});
	return {
		snapshot: {
			"settings-records": {
				kind: "records-workspace",
				busy: usage.isFetching || selections.isFetching || recipes.isFetching,
				revision,
				tabs: [
					{
						id: "ai",
						label: "AIの利用",
						description:
							"AIの利用記録です。詳細から切替・失敗理由とトークン数を確認できます。",
						rows: (usage.data?.items ?? []).map(usageRow),
						page: {
							query: {
								...queries.ai,
								pageIndex: usage.data?.pageIndex ?? queries.ai.pageIndex,
							},
							total: usage.data?.total ?? 0,
						},
						columns: [
							{ id: "started", label: "日時" },
							{ id: "purpose", label: "用途" },
							{ id: "source", label: "利用先" },
							{ id: "model", label: "モデル" },
							{ id: "status", label: "結果" },
						],
						loading: usage.isFetching && !usage.data,
						error: usage.isError
							? "利用記録を読み込めません。記録を更新して再試行してください。"
							: undefined,
					},
					{
						id: "toolchains",
						label: "ツールチェーン",
						description: "処理の選択と実行結果の記録です（30日保持）。",
						rows: (selections.data?.items ?? []).map(selectionRow),
						page: {
							query: {
								...queries.toolchains,
								pageIndex:
									selections.data?.pageIndex ?? queries.toolchains.pageIndex,
							},
							total: selections.data?.total ?? 0,
						},
						columns: [
							{ id: "createdAt", label: "日時" },
							{ id: "process", label: "処理" },
							{ id: "outcome", label: "結果" },
						],
						loading: selections.isFetching && !selections.data,
						error: selections.isError
							? "選択の記録を読み込めません。記録を更新して再試行してください。"
							: undefined,
						proceduresPage: {
							query: {
								...queries.procedures,
								pageIndex:
									recipes.data?.pageIndex ?? queries.procedures.pageIndex,
							},
							total: recipes.data?.total ?? 0,
						},
						procedures: recipes.data?.items.map(procedureRow) ?? [],
						proceduresLoading: recipes.isFetching && !recipes.data,
						proceduresError: recipes.isError
							? "取得手順を読み込めません。記録を更新して再試行してください。"
							: undefined,
					},
				],
				dataDescription: [
					"会話と設定はこの端末に保存します。APIキーは暗号化して保管します。",
					"クラウド送信の許可は各用途の設定で確認します。移行中は既存設定の「AIの使い方」から変更できます。費用は利用したサービスで確認してください。",
					"診断データには接続状態とAIの利用先の記録を保存します。",
				],
				dataError: diagnostics.isError
					? "接続状態を読み込めません。記録を更新して再試行してください。"
					: diagnostics.data?.keyError
						? "保存済みキーを開けません。backendの暗号鍵を確認してください。"
						: undefined,
			},
		},
		dispatch: session.dispatch,
	};
}
