import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { model3dApiFor } from "./api";
import { useModel3dRuntime } from "./use-model3d-runtime";

export const MODEL3D_ADAPTER_REF = "adapter:model3d@1";

/** The 3D model screen: every action is local and goes through the authenticated model3d API. */
export const model3dWebAdapter: WebArtifactAdapter = {
	adapterRef: MODEL3D_ADAPTER_REF,
	useArtifact({ client, artifactRevisionId, visible }) {
		const { runtime, loading, error, refresh } = useModel3dRuntime({
			client,
			api: model3dApiFor(client),
			artifactRevisionId,
			visible,
		});
		return {
			phase: error
				? { kind: "error", message: "3Dモデルの情報を取得できませんでした。" }
				: loading
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: runtime.snapshot,
			targetOf: () => undefined,
			local: (_binding, event) => runtime.dispatch(event),
			settled: () => {},
			refresh: () => {
				void refresh();
			},
		};
	},
};
