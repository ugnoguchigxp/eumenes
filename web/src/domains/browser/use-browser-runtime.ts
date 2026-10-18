import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import { queryRoots } from "../../queryKeys";
import type { BrowserApi } from "./api";
import { BROWSER_SOURCE, browserSourceData } from "./contracts";
import { browserResource } from "./source";

const SOURCE_POLL_MS = 5_000;
const BUSY_POLL_MS = 2_000;
const TABS_POLL_MS = 5_000;

const savePathMessages: Record<string, string> = {
	invalid_browser_setting:
		"パスは絶対パスで入力してください（空にすると設定を消します）。",
	browser_executable_invalid:
		"そのパスに実行できるファイルが見つかりません。Braveの実行ファイルのパスを確認してください。",
};

/** Builds the `browser` resource from the authenticated source and API; only the path is saved here. */
export function useBrowserRuntime({
	client,
	api,
	artifactRevisionId,
	visible,
}: {
	client: EumenesClient;
	api: BrowserApi;
	artifactRevisionId: string;
	/** False while the screen is hidden behind another tab. */
	visible: boolean;
}) {
	const cache = useQueryClient();
	const root = useMemo(
		() => [queryRoots.browser, client.identity] as const,
		[client.identity],
	);
	const source = useQuery({
		queryKey: [...root, "source", artifactRevisionId],
		queryFn: async ({ signal }) =>
			browserSourceData.parse(
				(
					await client.toolchainArtifactSource(
						artifactRevisionId,
						BROWSER_SOURCE,
						undefined,
						signal,
					)
				).data,
			),
		refetchInterval: (q) => {
			const data = q.state.data;
			const working =
				data?.connection.state === "connecting" ||
				data?.captures.some((c) =>
					["queued", "capturing", "encoding"].includes(c.state),
				) ||
				data?.tasks.some((t) => ["queued", "running"].includes(t.state));
			return working ? BUSY_POLL_MS : visible ? SOURCE_POLL_MS : false;
		},
	});
	const connected = source.data?.connection.state === "connected";
	// Reading the tabs asks Brave again, so the list follows tabs opened or closed there.
	const tabs = useQuery({
		queryKey: [...root, "tabs"],
		enabled: connected,
		queryFn: ({ signal }) => api.tabs(signal),
		refetchInterval: visible ? TABS_POLL_MS : false,
	});
	const path = useQuery({
		queryKey: [...root, "setting"],
		queryFn: ({ signal }) => api.setting(signal),
	});

	const resource = useMemo(
		() =>
			browserResource({
				data: source.data,
				tabs: connected ? tabs.data : undefined,
				executablePath: path.data,
				loading: source.isPending,
				error: source.error
					? "ブラウザの情報を取得できませんでした。"
					: undefined,
			}),
		[
			source.data,
			source.isPending,
			source.error,
			tabs.data,
			connected,
			path.data,
		],
	);

	const refresh = useCallback(
		() => cache.invalidateQueries({ queryKey: root }),
		[cache, root],
	);

	async function local(event: ArtifactEvent): Promise<Receipt> {
		if (event.source !== BROWSER_SOURCE)
			return { status: "rejected", message: "対象が見つかりません。" };
		if (event.action !== "browser-save-path")
			return { status: "rejected", message: "この操作は利用できません。" };
		const value = event.values.path;
		if (typeof value !== "string")
			return { status: "rejected", message: "パスを入力してください。" };
		try {
			cache.setQueryData([...root, "setting"], await api.saveSetting(value));
			await cache.invalidateQueries({ queryKey: [...root, "source"] });
			return {
				status: "accepted",
				message: value
					? "Braveの実行ファイルのパスを保存しました。"
					: "Braveの実行ファイルのパスを消しました。",
			};
		} catch (error) {
			return {
				status: "rejected",
				message:
					(error instanceof ApiError && savePathMessages[error.message]) ||
					"パスを保存できませんでした。",
			};
		}
	}

	return {
		resource,
		loading: source.isPending,
		error: source.error,
		local,
		refresh,
	};
}
