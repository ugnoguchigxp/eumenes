import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { queryRoots } from "../../queryKeys";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { openDocling } from "./open";

function useDoclingArtifact({
	client,
	artifact,
}: AdapterHostContext): AdapterState {
	const query = useQuery({
		queryKey: [queryRoots.docling, client.identity, "status"],
		queryFn: ({ signal }) => client.doclingStatus(signal),
		retry: false,
	});
	const [busy, setBusy] = useState(false);
	const active = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			active.current?.abort();
		},
		[
			client,
			query.data?.revision,
			query.data?.configured,
			query.data?.publicOrigin,
		],
	);
	const source =
		artifact.sourceBindings.find((s) => s.query === "query:docling.launcher@1")
			?.source ?? "docling-launcher";
	return {
		phase: query.isPending
			? { kind: "loading" }
			: query.isError
				? { kind: "error", message: "接続情報を取得できませんでした。" }
				: { kind: "ready" },
		snapshot: {
			[source]: {
				kind: "external-app-launcher",
				revision: query.data?.revision ?? 0,
				available: !!query.data?.configured,
				busy,
			},
		},
		targetOf: () => undefined,
		async local(binding) {
			if (
				binding.eventAction !== "external-app-open" ||
				!query.data?.publicOrigin ||
				!query.data.configured ||
				active.current
			)
				return { status: "rejected", message: "この操作は利用できません。" };
			const controller = new AbortController();
			active.current = controller;
			setBusy(true);
			try {
				return await openDocling(client, query.data.publicOrigin, controller);
			} finally {
				if (active.current === controller) {
					active.current = null;
					setBusy(false);
				}
			}
		},
		settled: () => {},
		refresh: () => {
			void query.refetch();
		},
	};
}

export const doclingWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:docling@1",
	useArtifact: useDoclingArtifact,
};
