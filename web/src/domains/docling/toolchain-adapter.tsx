import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { queryRoots } from "../../queryKeys";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { doclingMessages, openDocling } from "./open";

const configurationError =
	"接続情報を取得できませんでした。接続を確認して、再試行してください。";

function useDoclingArtifact({
	client,
	artifact,
}: AdapterHostContext): AdapterState {
	const query = useQuery({
		queryKey: [queryRoots.docling, client.identity, "status"],
		queryFn: ({ signal }) => client.doclingStatus(signal),
		retry: false,
	});
	const scope = useMemo(
		() => ({
			client,
			revision: query.data?.revision,
			configured: query.data?.configured,
			publicOrigin: query.data?.publicOrigin,
		}),
		[
			client,
			query.data?.revision,
			query.data?.configured,
			query.data?.publicOrigin,
		],
	);
	const [attempt, setAttempt] = useState(0);
	const [preparation, setPreparation] = useState<{
		scope: typeof scope;
		ready: boolean;
		error?: string;
	} | null>(null);
	const [opening, setOpening] = useState<typeof scope | null>(null);
	const active = useRef<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		if (scope.configured && scope.publicOrigin) {
			const signal = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(200_000),
			]);
			active.current = controller;
			// Effect replay can cancel before dispatch (React StrictMode with cached settings).
			void Promise.resolve()
				.then(() => {
					signal.throwIfAborted();
					return client.doclingReady(signal);
				})
				.then((value) => {
					signal.throwIfAborted();
					if (
						!value.configured ||
						value.revision !== scope.revision ||
						value.publicOrigin !== scope.publicOrigin
					)
						throw new Error("docling_connection_changed");
					setPreparation({ scope, ready: true });
				})
				.catch((error: unknown) => {
					if (!controller.signal.aborted)
						setPreparation({
							scope,
							ready: false,
							error:
								doclingMessages[
									signal.aborted
										? "docling_timeout"
										: error instanceof Error
											? error.message
											: ""
								] ??
								"起動を準備できませんでした。接続を確認して、再試行してください。",
						});
				})
				.finally(() => {
					if (active.current === controller) active.current = null;
				});
		}
		return () => {
			controller.abort();
			active.current?.abort();
			active.current = null;
		};
	}, [client, scope, attempt]);
	const current = preparation?.scope === scope ? preparation : null;
	const ready = !query.isError && !!scope.configured && !!current?.ready;
	const source =
		artifact.sourceBindings.find((s) => s.query === "query:docling.launcher@1")
			?.source ?? "docling-launcher";
	return {
		phase: query.isPending ? { kind: "loading" } : { kind: "ready" },
		snapshot: {
			[source]: {
				kind: "external-app-launcher",
				revision: query.data?.revision ?? 0,
				available: ready,
				busy: opening === scope || (query.isError && query.isFetching),
				preparing: !query.isError && !!scope.configured && !current,
				error: query.isError ? configurationError : current?.error,
			},
		},
		targetOf: () => undefined,
		async local(binding) {
			if (
				binding.eventAction !== "external-app-open" ||
				!scope.publicOrigin ||
				!ready ||
				active.current
			)
				return { status: "rejected", message: "この操作は利用できません。" };
			const controller = new AbortController();
			active.current = controller;
			setOpening(scope);
			try {
				return await openDocling(client, scope.publicOrigin, controller);
			} finally {
				if (active.current === controller) {
					active.current = null;
					setOpening(null);
				}
			}
		},
		settled: () => {},
		refresh: () => {
			if (active.current) return;
			const controller = new AbortController();
			active.current = controller;
			setPreparation(null);
			void query.refetch({ throwOnError: false }).then((result) => {
				if (controller.signal.aborted || active.current !== controller) return;
				active.current = null;
				if (result.isError) {
					setPreparation({ scope, ready: false, error: configurationError });
					return;
				}
				// A changed scope starts its own request through the effect above.
				if (
					result.data?.revision === scope.revision &&
					result.data?.configured === scope.configured &&
					result.data?.publicOrigin === scope.publicOrigin
				)
					setAttempt((value) => value + 1);
			});
		},
	};
}

export const doclingWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:docling@1",
	useArtifact: useDoclingArtifact,
};
