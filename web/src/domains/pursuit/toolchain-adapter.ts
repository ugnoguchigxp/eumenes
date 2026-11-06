import type { Snapshot } from "@eumenes/artifact-ui";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { queryRoots } from "../../queryKeys";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";

const report = z.object({
	kind: z.literal("work-result"),
	revision: z.number().int().nonnegative(),
	targetRef: z.string().optional(),
	work: z.object({
		title: z.string(),
		status: z.string(),
		request: z.string().optional(),
		summary: z.string(),
		sections: z
			.array(z.object({ title: z.string(), items: z.array(z.string()) }))
			.optional(),
	}),
});

/** Read the owner's saved result into the existing work-result component. */
export const pursuitWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:pursuit@1",
	useArtifact(context) {
		const query = useQuery({
			queryKey: [
				queryRoots.toolchainArtifacts,
				context.client.identity,
				context.artifactRevisionId,
				"pursuit-report",
				context.targetRef,
			],
			enabled: context.visible,
			retry: false,
			queryFn: async ({ signal }) =>
				report.parse(
					(
						await context.client.toolchainArtifactSource(
							context.artifactRevisionId,
							"pursuit-report",
							context.targetRef,
							signal,
						)
					).data,
				),
		});
		const snapshot: Snapshot = query.data
			? { "pursuit-report": query.data }
			: {};
		return {
			targetOf: (source) =>
				source === "pursuit-report" ? query.data?.targetRef : undefined,
			phase: query.isLoading
				? { kind: "loading" }
				: query.isError || !query.data
					? { kind: "blocked", message: "調査報告を読み込めません。" }
					: { kind: "ready" },
			snapshot,
			local: async () => ({
				status: "rejected",
				message: "調査への依頼や訂正は会話から行えます。",
			}),
			settled() {
				void query.refetch();
			},
			refresh() {
				void query.refetch();
			},
		};
	},
};
