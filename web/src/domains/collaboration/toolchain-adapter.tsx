import type { Snapshot } from "@eumenes/artifact-ui";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { queryRoots } from "../../queryKeys";

const resource = z.object({
	kind: z.literal("work-result"),
	revision: z.number().int().nonnegative(),
	targetRef: z.string(),
	work: z.object({
		title: z.string(),
		status: z.string(),
		request: z.string().optional(),
		summary: z.string().optional(),
		sections: z
			.array(z.object({ title: z.string(), items: z.array(z.string()) }))
			.optional(),
	}),
});

/** Registered OpenUI components show the host's canonical draft and child result; editing continues in chat. */
const adapter = (kind: "pipeline" | "interact"): WebArtifactAdapter => ({
	adapterRef: `adapter:collaboration.${kind}@1`,
	useArtifact(context) {
		const query = useQuery({
			queryKey: [
				queryRoots.toolchainArtifacts,
				context.client.identity,
				context.artifactRevisionId,
				"collaboration",
				context.conversationId,
				context.targetRef,
			],
			enabled: !!context.conversationId && context.visible,
			refetchInterval: context.visible ? 2000 : false,
			queryFn: async ({ signal }) => {
				const source = await context.client.toolchainArtifactSource(
					context.artifactRevisionId,
					"collaboration",
					context.targetRef,
					signal,
					{ conversationId: context.conversationId },
				);
				return resource.parse(source.data);
			},
		});
		const snapshot: Snapshot = query.data ? { collaboration: query.data } : {};
		return {
			targetOf: (source) =>
				source === "collaboration" ? query.data?.targetRef : undefined,
			phase: query.isLoading
				? { kind: "loading" }
				: query.isError || !query.data
					? {
							kind: "blocked",
							message: "会話から共同作業を始めると、現在の内容を表示します。",
						}
					: { kind: "ready" },
			snapshot,
			local: async () => ({
				status: "rejected",
				message: "修正・回答・通常会話への復帰は、会話で伝えてください。",
			}),
			settled() {
				void query.refetch();
			},
			refresh() {
				void query.refetch();
			},
		};
	},
});
export const collaborationWebAdapters = (["pipeline", "interact"] as const).map(
	adapter,
);
