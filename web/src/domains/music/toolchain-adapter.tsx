import { useQueryClient } from "@tanstack/react-query";
import { queryRoots } from "../../queryKeys";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { useMusicRuntime } from "./use-music-runtime";

export const MUSIC_SCREEN_ADAPTER_REF = "adapter:music-screen@1";

/** The registered view uses the existing authenticated creation, cancellation and audio APIs. */
export const musicScreenWebAdapter: WebArtifactAdapter = {
	adapterRef: MUSIC_SCREEN_ADAPTER_REF,
	useArtifact({ client, artifact }) {
		const cache = useQueryClient();
		const definition = JSON.stringify(
			artifact.variants.find((v) => v.id === artifact.defaultVariant)
				?.definition,
		);
		const { runtime, loading, error } = useMusicRuntime(
			client,
			"main",
			definition,
		);
		return {
			phase: error
				? { kind: "error", message: "楽曲の情報を取得できませんでした。" }
				: loading
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: runtime.snapshot,
			targetOf: () => undefined,
			local: (_binding, event) => runtime.dispatch(event),
			settled: () => {},
			refresh: () => {
				void cache.invalidateQueries({ queryKey: [queryRoots.music] });
			},
		};
	},
};
