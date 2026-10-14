import { useQueryClient } from "@tanstack/react-query";
import {
	definitionRequests,
	parseDefinition,
} from "@eumenes/artifact-ui/contracts";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { queryRoots } from "../../queryKeys";
import { useImageRuntime } from "./use-image-runtime";

export const IMAGE_SCREEN_ADAPTER_REF = "adapter:image-screen@1";

/** Registered presentation with the existing authenticated image operations. */
export const imageScreenWebAdapter: WebArtifactAdapter = {
	adapterRef: IMAGE_SCREEN_ADAPTER_REF,
	useArtifact({ client, artifact }) {
		const cache = useQueryClient();
		const definition = artifact.variants.find(
			(v) => v.id === artifact.defaultVariant,
		)?.definition;
		const request = definition
			? definitionRequests(parseDefinition(JSON.stringify(definition))).find(
					(r) => r.view === "image-workspace",
				)
			: undefined;
		const { runtime, loading, error } = useImageRuntime(
			client,
			"main",
			undefined,
			request?.view === "image-workspace"
				? request.creationOptions?.defaults
				: undefined,
		);
		return {
			phase: error
				? { kind: "error", message: "画像の情報を取得できませんでした。" }
				: loading
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: runtime.snapshot,
			targetOf: () => undefined,
			local: (_binding, event) => runtime.dispatch(event),
			settled: () => {},
			refresh: () => {
				void cache.invalidateQueries({ queryKey: [queryRoots.image] });
			},
		};
	},
};
