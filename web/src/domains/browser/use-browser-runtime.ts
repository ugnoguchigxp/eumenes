import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import type {
	ArtifactEvent,
	BrowserWorkspaceResource,
	Receipt,
} from "@eumenes/artifact-ui/contracts";
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

const browseMessages: Record<string, string> = {
	browser_executable_invalid:
		"選んだファイルは実行できません。Braveのアプリを選んでください。",
	browser_browse_busy: "ファイルを選ぶ画面がすでに開いています。",
	browser_browse_unsupported:
		"このコンピュータではファイルを選べません。パスを入力してください。",
	browser_browse_failed:
		"ファイルを選ぶ画面を開けませんでした。パスを入力してください。",
};

/** Builds the `browser` resource from the authenticated source and API; only the path is saved here. */
export function useBrowserRuntime({
	client,
	api,
	artifactRevisionId,
	visible,
	conversationId = "main",
}: {
	client: EumenesClient;
	api: BrowserApi;
	artifactRevisionId: string;
	/** False while the screen is hidden behind another tab. */
	visible: boolean;
	conversationId?: string;
}) {
	const cache = useQueryClient();
	const root = useMemo(
		() => [queryRoots.browser, client.identity] as const,
		[client.identity],
	);
	const source = useQuery({
		queryKey: [...root, "source", artifactRevisionId, conversationId],
		queryFn: async ({ signal }) => {
			const [source, tasks] = await Promise.all([
				client.toolchainArtifactSource(
					artifactRevisionId,
					BROWSER_SOURCE,
					undefined,
					signal,
				),
				api.tasks(conversationId, signal),
			]);
			return { ...browserSourceData.parse(source.data), tasks };
		},
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
	const connected = source.data?.connection.availability.available === true;
	// Reading the tabs asks Brave again, so the list follows tabs opened or closed there.
	const tabs = useQuery({
		queryKey: [...root, "tabs", source.data?.connection.connectionId],
		enabled: connected,
		queryFn: ({ signal }) => api.tabs(signal),
		refetchInterval: visible ? TABS_POLL_MS : false,
	});
	// A file chosen in the OS dialog fills the field until it is saved.
	const [picked, setPicked] =
		useState<BrowserWorkspaceResource["pickedExecutable"]>();
	const picks = useRef(0);
	const path = useQuery({
		queryKey: [...root, "setting"],
		queryFn: ({ signal }) => api.setting(signal),
	});

	const bridge = useQuery({
		queryKey: [...root, "bridge"],
		queryFn: ({ signal }) => api.bridge(signal),
	});
	const resource = useMemo(
		() =>
			browserResource({
				data: source.data,
				bridge: bridge.data,
				conversationId,
				tabs: connected ? tabs.data : undefined,
				executablePath: path.data?.executablePath,
				suggestedExecutablePath: path.data?.suggestedPath,
				pickedExecutable: picked,
				canBrowseExecutable: path.data?.canBrowse ?? false,
				loading: source.isPending,
				error: source.error
					? "ブラウザの情報を取得できませんでした。"
					: undefined,
			}),
		[
			source.data,
			bridge.data,
			conversationId,
			source.isPending,
			source.error,
			tabs.data,
			connected,
			path.data,
			picked,
		],
	);

	const refresh = useCallback(
		() => cache.invalidateQueries({ queryKey: root }),
		[cache, root],
	);

	async function browse(): Promise<Receipt> {
		try {
			const chosen = await api.browse();
			if (chosen === null) return { status: "accepted", message: "" };
			picks.current += 1;
			setPicked({ path: chosen, pickId: picks.current });
			return {
				status: "accepted",
				message: "Braveを選びました。「保存」を押すと使えます。",
			};
		} catch (error) {
			return {
				status: "rejected",
				message:
					(error instanceof ApiError && browseMessages[error.message]) ||
					"ファイルを選べませんでした。",
			};
		}
	}

	async function local(event: ArtifactEvent): Promise<Receipt> {
		if (event.source !== BROWSER_SOURCE)
			return { status: "rejected", message: "対象が見つかりません。" };
		if (event.action === "browser-bridge-save") {
			try {
				const { enabled, clear, token, expectedRevision } = event.values;
				if (
					typeof enabled !== "boolean" ||
					typeof clear !== "boolean" ||
					typeof token !== "string" ||
					typeof expectedRevision !== "string"
				)
					return {
						status: "rejected",
						message: "設定の内容を確認してください。",
					};
				await api.saveBridge({
					enabled,
					clear,
					expectedRevision: Number(expectedRevision),
					...(token ? { token } : {}),
				});
				await refresh();
				return {
					status: "accepted",
					message: "接続の承認設定を保存しました。",
				};
			} catch {
				await refresh();
				return {
					status: "rejected",
					message:
						"承認設定を保存できませんでした。現在の設定を確認してください。",
				};
			}
		}
		if (event.action === "browser-browse-path") return browse();
		if (event.action !== "browser-save-path")
			return { status: "rejected", message: "この操作は利用できません。" };
		const value = event.values.path;
		if (typeof value !== "string")
			return { status: "rejected", message: "パスを入力してください。" };
		try {
			await api.saveSetting(value);
			// Clearing the path brings the offered install back, so the setting is read again.
			await Promise.all([
				cache.invalidateQueries({ queryKey: [...root, "setting"] }),
				cache.invalidateQueries({ queryKey: [...root, "source"] }),
			]);
			// Only now, so the field does not fall back to the old value while the setting is read.
			setPicked(undefined);
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
