import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UsageDashboardResource } from "@eumenes/artifact-ui/contracts";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import {
	usageQuerySchema,
	usageRange,
	type UsageQuery,
} from "../../../../api/domains/usage/contracts";

function useUsageArtifact({
	client,
	artifactRevisionId,
	visible,
}: AdapterHostContext): AdapterState {
	const [params, setParams] = useState<UsageQuery | undefined>();
	const query = useQuery({
		queryKey: ["usage-dashboard", client.identity, artifactRevisionId, params],
		queryFn: ({ signal }) =>
			client.toolchainArtifactSource(
				artifactRevisionId,
				"usage",
				undefined,
				signal,
				params,
			),
		placeholderData: (previous) => previous,
		refetchInterval: visible ? 15000 : false,
		enabled: visible,
		retry: false,
	});
	const refresh = () => {
		void query.refetch();
	};
	const data = query.data?.data as UsageDashboardResource | undefined;
	return {
		phase: data
			? { kind: "ready" }
			: query.isError
				? {
						kind: "error",
						message: "利用状況を取得できません。接続を確認してください。",
					}
				: { kind: "loading" },
		snapshot: data
			? {
					usage: {
						...data,
						busy: query.isFetching,
						message: query.isError
							? "更新できませんでした。表示は最終更新時点の記録です。"
							: "",
					},
				}
			: {},
		targetOf: () => undefined,
		async local(binding, event) {
			if (binding.eventAction === "usage-refresh") {
				refresh();
				return { status: "accepted", message: "" };
			}
			if (binding.eventAction !== "usage-query")
				return { status: "rejected", message: "操作を確認してください。" };
			const parsed = usageQuerySchema.safeParse({
				...event.values,
				pageIndex: Number(event.values.pageIndex),
			});
			if (!parsed.success)
				return {
					status: "rejected",
					message: "期間とフィルターを確認してください。",
				};
			try {
				usageRange(parsed.data);
			} catch {
				return {
					status: "rejected",
					message: "期間は開始日から366日以内にしてください。",
				};
			}
			setParams(parsed.data);
			return { status: "accepted", message: "" };
		},
		async settled() {
			await query.refetch();
		},
		refresh,
		describeRejection(code) {
			return (
				{
					usage_revision_conflict:
						"単価が別の操作で更新されました。再読込後に確認してください。",
					usage_rate_conflict: "同じモデルと適用開始の単価が既にあります。",
					usage_model_unknown: "保存済みのLiveモデルを選んでください。",
					invalid_usage_period: "期間は開始日から366日以内にしてください。",
				} as Record<string, string>
			)[code ?? ""];
		},
	};
}
export const usageWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:usage@1",
	useArtifact: useUsageArtifact,
};
