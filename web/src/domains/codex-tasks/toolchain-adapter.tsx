import { useQuery } from "@tanstack/react-query";
import type { FormResource } from "@eumenes/artifact-ui/contracts";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { queryRoots } from "../../queryKeys";
export const codexTasksWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:codex-tasks@1",
	useArtifact({ client, artifactRevisionId, artifact }) {
		const source = artifact.sourceBindings[0]?.source ?? "codex-settings";
		const query = useQuery({
			queryKey: [
				queryRoots.kanban,
				client.identity,
				artifactRevisionId,
				source,
			],
			queryFn: async ({ signal }) => {
				const result = await client.toolchainArtifactSource(
					artifactRevisionId,
					source,
					undefined,
					signal,
				);
				const data = result.data as {
					settings: {
						revision: number;
						enabled: boolean;
						runnerId: string | null;
						workspaceId: string | null;
						resourceId: string | null;
					};
					allowed: { resources: string[] };
					resources: { id: string; label: string }[];
				};
				const settings = data.settings;
				const resources = [...data.resources];
				if (
					settings.resourceId &&
					!resources.some((r) => r.id === settings.resourceId)
				)
					resources.push({
						id: settings.resourceId,
						label: "保存済みのモデル（現在は利用できません）",
					});
				return {
					kind: "form" as const,
					revision: result.revision,
					submitLabel: "保存",
					fields: [
						{
							id: "enabled",
							label: "Codexでの作業を有効にする",
							type: "select",
							options: ["true", "false"],
							optionLabels: { true: "有効", false: "無効" },
						},
						{
							id: "resourceId",
							label: "開発に使うモデル",
							type: "select",
							options: ["", ...resources.map((r) => r.id)],
							optionLabels: {
								"": data.resources.length
									? "モデルを選んでください"
									: "AI接続の設定でCodexのモデルを追加してください",
								...Object.fromEntries(resources.map((r) => [r.id, r.label])),
							},
						},
					],
					defaults: {
						expectedRevision: String(settings.revision),
						enabled: String(settings.enabled),
						runnerId: settings.runnerId ?? "local",
						workspaceId: settings.workspaceId ?? "eumenes",
						resourceId: settings.resourceId ?? "",
					},
				} as FormResource;
			},
		});
		return {
			// A failed refresh is shown as an error, not as the last settings read.
			phase: query.isError
				? { kind: "error", message: "Codexの設定を取得できません" }
				: query.data
					? { kind: "ready" }
					: { kind: "loading" },
			snapshot: query.data && !query.isError ? { [source]: query.data } : {},
			targetOf: () => undefined,
			local: async () => ({
				status: "rejected",
				message: "この操作はできません",
			}),
			settled: async () => {
				await query.refetch();
			},
			refresh: () => {
				void query.refetch();
			},
			describeRejection: (code) =>
				code === "codex_configuration_unregistered"
					? "保存済みのCodexモデルを指定してください"
					: undefined,
		};
	},
};
