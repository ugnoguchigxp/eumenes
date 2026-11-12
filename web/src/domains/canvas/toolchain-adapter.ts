import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";

export const canvasWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:canvas@1",
	useArtifact({ conversationId, visible }) {
		return {
			phase: { kind: "ready" },
			snapshot: {
				canvas: {
					kind: "canvas-workspace",
					revision: 1,
					conversationId,
					visible,
				},
			},
			targetOf: () => undefined,
			local: async () => ({
				status: "rejected",
				message: "この操作は利用できません。",
			}),
			settled: () => {},
			refresh: () => {},
		};
	},
};
