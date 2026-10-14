import type { Receipt, Resource } from "@eumenes/artifact-ui";
import type { TableQuery } from "@eumenes/design-system";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Usage } from "../../../../client/settings";
import { usagePageQuerySchema } from "../../../../client/settings";
import {
	recipePageQuerySchema,
	selectionPageQuerySchema,
} from "../../../../client/toolchain-history";
import { queryRoots } from "../../queryKeys";
import {
	procedureRow,
	selectionRow,
	usageRow,
	type Recipe,
	type Selection,
} from "./records-presentation";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";

export const RECORDS_ADAPTER_REF = "adapter:records@1";
const QUERY = {
	usage: "query:records.usage@1",
	selections: "query:records.selections@1",
	recipes: "query:records.recipes@1",
	diagnostics: "query:records.diagnostics@1",
	export: "query:records.export@1",
} as const;

type Page<T> = {
	items: T[];
	total: number;
	pageIndex: number;
	pageSize: number;
};
type Tables = {
	ai: Page<Usage>;
	toolchains: Page<Selection>;
	procedures: Page<Recipe>;
};
type TableId = keyof Tables;
const defaults = {
	ai: usagePageQuerySchema.parse({}),
	toolchains: selectionPageQuerySchema.parse({}),
	procedures: recipePageQuerySchema.parse({}),
};
const querySchemas = {
	ai: usagePageQuerySchema,
	toolchains: selectionPageQuerySchema,
	procedures: recipePageQuerySchema,
};
const tableName = {
	ai: "usage",
	toolchains: "selections",
	procedures: "recipes",
} as const;
const isTable = (value: unknown): value is TableId =>
	value === "ai" || value === "toolchains" || value === "procedures";

/**
 * The records screen (AI usage, toolchain selections, saved procedures, diagnostics) on the
 * registered path: the first pages come from the artifact's sources, paging/sorting/search is a
 * read of the same source with `params` (no action, nothing written), and procedure changes are
 * the `records.recipe-*` writes whose receipts make the screen read the procedures source again.
 */
function useRecordsArtifact({
	client,
	artifact,
	artifactRevisionId,
}: AdapterHostContext): AdapterState {
	const cache = useQueryClient();
	const sourceOf = (query: string) =>
		artifact.sourceBindings.find((s) => s.query === query)?.source;
	const names = {
		usage: sourceOf(QUERY.usage),
		selections: sourceOf(QUERY.selections),
		recipes: sourceOf(QUERY.recipes),
		diagnostics: sourceOf(QUERY.diagnostics),
	};
	const keys = (Object.keys(names) as Array<keyof typeof names>).map(
		(name) => ({
			name,
			source: names[name],
		}),
	);
	const reads = useQueries({
		queries: keys.map(({ name, source }) => ({
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"records",
				artifactRevisionId,
				name,
			],
			queryFn: async ({ signal }: { signal: AbortSignal }) =>
				(
					await client.toolchainArtifactSource(
						artifactRevisionId,
						source!,
						undefined,
						signal,
					)
				).data,
			enabled: !!source,
			retry: false,
		})),
	});
	const read = (name: keyof typeof names) =>
		reads[keys.findIndex((k) => k.name === name)]!;
	const usage = read("usage");
	const selections = read("selections");
	const recipes = read("recipes");
	const diagnostics = read("diagnostics");

	// A page read answers with the page itself; it replaces the source's first page until the
	// screen is refreshed.
	const [pages, setPages] = useState<Partial<Tables>>({});
	const [queries, setQueries] = useState<Record<TableId, TableQuery>>(defaults);
	const data = {
		ai: pages.ai ?? (usage.data as Page<Usage> | undefined),
		toolchains:
			pages.toolchains ?? (selections.data as Page<Selection> | undefined),
		procedures: pages.procedures ?? (recipes.data as Page<Recipe> | undefined),
	};
	const observed = [
		data.ai,
		data.toolchains,
		data.procedures,
		queries,
		diagnostics.data,
		usage.isFetching,
		selections.isFetching,
		recipes.isFetching,
		usage.isError,
		selections.isError,
		recipes.isError,
		diagnostics.isError,
	];
	const [version, setVersion] = useState({ observed, revision: 0 });
	if (observed.some((value, index) => value !== version.observed[index]))
		setVersion({ observed, revision: version.revision + 1 });
	const revision = version.revision;

	const refetchSources = async () => {
		setPages({});
		setQueries(defaults);
		const results = await Promise.all(reads.map((r) => r.refetch()));
		if (results.some((r) => r.isError)) throw new Error("refresh_failed");
	};
	const diag = diagnostics.data as { keyError: string | null } | undefined;
	const resource: Resource = {
		kind: "records-workspace",
		compact: true,
		busy: usage.isFetching || selections.isFetching || recipes.isFetching,
		revision,
		tabs: [
			{
				id: "ai",
				label: "AIの利用",
				rows: (data.ai?.items ?? []).map(usageRow),
				page: {
					query: {
						...queries.ai,
						pageIndex: data.ai?.pageIndex ?? queries.ai.pageIndex,
					},
					total: data.ai?.total ?? 0,
				},
				columns: [
					{ id: "started", label: "日時" },
					{ id: "purpose", label: "用途" },
					{ id: "source", label: "利用先" },
					{ id: "model", label: "モデル" },
					{ id: "status", label: "結果" },
				],
				loading: usage.isFetching && !data.ai,
				error: usage.isError
					? "利用記録を読み込めません。記録を更新して再試行してください。"
					: undefined,
			},
			{
				id: "toolchains",
				label: "ツールチェーン",
				rows: (data.toolchains?.items ?? []).map(selectionRow),
				page: {
					query: {
						...queries.toolchains,
						pageIndex:
							data.toolchains?.pageIndex ?? queries.toolchains.pageIndex,
					},
					total: data.toolchains?.total ?? 0,
				},
				columns: [
					{ id: "createdAt", label: "日時" },
					{ id: "process", label: "処理" },
					{ id: "outcome", label: "結果" },
				],
				loading: selections.isFetching && !data.toolchains,
				error: selections.isError
					? "選択の記録を読み込めません。記録を更新して再試行してください。"
					: undefined,
				proceduresPage: {
					query: {
						...queries.procedures,
						pageIndex:
							data.procedures?.pageIndex ?? queries.procedures.pageIndex,
					},
					total: data.procedures?.total ?? 0,
				},
				procedures: (data.procedures?.items ?? []).map(procedureRow),
				proceduresLoading: recipes.isFetching && !data.procedures,
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
			: diag?.keyError
				? "保存済みキーを開けません。backendの暗号鍵を確認してください。"
				: undefined,
	};

	const snapshot: Record<string, Resource> = {};
	for (const source of new Set(
		artifact.actionBindings
			.filter((b) => b.eventAction.startsWith("records-"))
			.map((b) => b.source),
	))
		snapshot[source] = resource;

	return {
		phase: { kind: "ready" },
		snapshot,
		targetOf: () => undefined,
		async local(binding) {
			try {
				if (binding.eventAction === "records-refresh") {
					await refetchSources();
					return { status: "accepted", message: "記録を更新しました" };
				}
				if (binding.eventAction === "records-download") {
					const source = sourceOf(QUERY.export);
					if (!source)
						return {
							status: "rejected",
							message: "この操作は受け付けられません",
						};
					const exported = await client.toolchainArtifactSource(
						artifactRevisionId,
						source,
					);
					const blob = new Blob(
						[
							JSON.stringify(
								{
									generatedAt: new Date().toISOString(),
									...(exported.data as object),
								},
								null,
								2,
							),
						],
						{ type: "application/json" },
					);
					const url = URL.createObjectURL(blob);
					try {
						const link = document.createElement("a");
						link.href = url;
						link.download = "eumenes-diagnostics.json";
						link.click();
					} finally {
						setTimeout(() => URL.revokeObjectURL(url), 0);
					}
					return { status: "accepted", message: "診断データを保存しました" };
				}
			} catch {
				return {
					status: "rejected",
					message: "操作に失敗しました。記録を更新して状態を確認してください",
				};
			}
			return { status: "rejected", message: "この操作は利用できません" };
		},
		sourceRead(event) {
			if (event.action !== "records-query") return null;
			const { tableId, ...raw } = event.values;
			if (!isTable(tableId))
				return Promise.resolve({
					status: "rejected" as const,
					message: "この操作は受け付けられません",
				});
			const query = querySchemas[tableId].safeParse(raw);
			const source = names[tableName[tableId]];
			if (!query.success || !source)
				return Promise.resolve({
					status: "rejected" as const,
					message: "この操作は受け付けられません",
				});
			return client
				.toolchainArtifactSource(
					artifactRevisionId,
					source,
					undefined,
					undefined,
					query.data,
				)
				.then(({ data }): Receipt => {
					setPages((old) => ({ ...old, [tableId]: data as Tables[TableId] }));
					setQueries((old) => ({ ...old, [tableId]: query.data }));
					return { status: "accepted", message: "" };
				})
				.catch((): Receipt => ({
					status: "rejected",
					message: "表を読み込めません。記録を更新して再試行してください。",
				}));
		},
		settled(_binding, result) {
			const receipt = result.receipt as { kind?: string } | undefined;
			if (
				receipt?.kind === "recipe-state" ||
				receipt?.kind === "recipe-delete"
			) {
				// The procedures changed: read them again from their source.
				setPages((old) => ({ ...old, procedures: undefined }));
				setQueries((old) => ({ ...old, procedures: defaults.procedures }));
				void cache.invalidateQueries({
					queryKey: [
						queryRoots.toolchainArtifacts,
						client.identity,
						"records",
						artifactRevisionId,
						"recipes",
					],
				});
			}
		},
		refresh: () => void refetchSources().catch(() => {}),
	};
}

export const recordsWebAdapter: WebArtifactAdapter = {
	adapterRef: RECORDS_ADAPTER_REF,
	useArtifact: useRecordsArtifact,
};
