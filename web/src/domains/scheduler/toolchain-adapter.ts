import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { genericWebAdapter } from "../toolchain-artifacts/generic-adapter";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { collectionQueryKey } from "../toolchain-artifacts/use-collections";

/** Registration and firing may happen while an empty list is already open. */
export const schedulerWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:scheduler@1",
	useArtifact(context) {
		const { client, visible, artifactRevisionId } = context;
		const cache = useQueryClient();
		useEffect(() => {
			if (!visible) return;
			const queryKey = collectionQueryKey(client.identity, artifactRevisionId);
			const refresh = () => {
				void cache.invalidateQueries({ queryKey }, { cancelRefetch: false });
			};
			refresh();
			return client.subscribeChanges(refresh);
		}, [artifactRevisionId, cache, client, visible]);
		return genericWebAdapter.useArtifact(context);
	},
};
