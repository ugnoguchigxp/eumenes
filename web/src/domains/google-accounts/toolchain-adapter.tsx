import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Snapshot } from "@eumenes/artifact-ui/contracts";
import type { GoogleAccountView } from "../../../../api/domains/google-accounts/contracts";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { ApiError } from "../../../../client";
const messages = {
	connected: "Googleアカウントを接続しました。",
	cancelled: "接続をキャンセルしました。",
	failed:
		"接続できませんでした。再接続では同じGoogleアカウントを選んでください。",
	expired: "認証の待ち時間を過ぎました。もう一度接続してください。",
};
export const googleAccountsWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:google-accounts@1",
	useArtifact(context) {
		const { client, artifactRevisionId, artifact, visible } = context;
		const source = artifact.sourceBindings[0]!.source;
		const [busy, setBusy] = useState(false);
		const [authorizationUrl, setAuthorizationUrl] = useState<string>();
		const running = useRef(false);
		const mounted = useRef(true);
		useEffect(() => {
			mounted.current = true;
			return () => {
				mounted.current = false;
			};
		}, []);
		const query = useQuery({
			queryKey: ["google-accounts", client.identity, artifactRevisionId],
			queryFn: async ({ signal }) =>
				(
					await client.toolchainArtifactSource(
						artifactRevisionId,
						source,
						undefined,
						signal,
					)
				).data as GoogleAccountView,
			enabled: visible,
			retry: false,
			refetchInterval: (q) =>
				visible
					? q.state.data?.pending || q.state.data?.status === "disconnecting"
						? 1500
						: 30_000
					: false,
			// OAuth runs in another tab; keep this local status read active while it has focus.
			refetchIntervalInBackground: true,
			refetchOnWindowFocus: "always",
			staleTime: 0,
		});
		const state = query.data;
		useEffect(() => {
			if (!state?.pending) setAuthorizationUrl(undefined);
		}, [state?.pending]);
		const snapshot: Snapshot = state
			? {
					[source]: {
						kind: "google-accounts",
						...state,
						busy,
						authorizationUrl,
						message: state.result ? messages[state.result] : undefined,
					},
				}
			: {};
		return {
			phase: state
				? { kind: "ready" }
				: query.isError
					? {
							kind: "error",
							message: "Google連携の状態を読み込めませんでした。",
						}
					: { kind: "loading" },
			snapshot,
			targetOf: () => undefined,
			refresh: () => {
				void query.refetch();
			},
			settled: () => {},
			async local(binding, event) {
				if (!state || running.current || event.revision !== state.revision)
					return {
						status: "rejected",
						message: "接続状態を確認してから、もう一度お試しください。",
					};
				if (
					!["google-connect", "google-disconnect", "google-cancel"].includes(
						binding.eventAction,
					)
				)
					return { status: "rejected", message: "この操作は利用できません。" };
				running.current = true;
				setBusy(true);
				// Open synchronously with the click; delayed opening is blocked by browsers.
				const popup =
					binding.eventAction === "google-connect"
						? window.open("about:blank", "_blank")
						: null;
				if (popup) popup.opener = null;
				try {
					if (binding.eventAction === "google-connect") {
						const result = await client.connectGoogleAccount(state.revision);
						if (mounted.current) {
							setAuthorizationUrl(result.url);
							if (popup) popup.location.href = result.url;
						} else popup?.close();
					} else if (binding.eventAction === "google-cancel")
						await client.cancelGoogleAccount(state.revision);
					else await client.disconnectGoogleAccount(state.revision);
					await query.refetch();
					return { status: "accepted", message: "" };
				} catch (error) {
					popup?.close();
					await query.refetch();
					return {
						status: "rejected",
						message:
							error instanceof ApiError && error.status === 409
								? "接続状態が変更されました。内容を確認してもう一度操作してください。"
								: "操作を完了できませんでした。接続状態を確認してもう一度お試しください。",
					};
				} finally {
					running.current = false;
					if (mounted.current) setBusy(false);
				}
			},
		};
	},
};
