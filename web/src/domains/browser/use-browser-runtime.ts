import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const ENDED_TASK_STATES: ReadonlySet<string> = new Set([
	"completed",
	"needs_input",
	"failed",
	"cancelled",
	"expired",
	"indeterminate",
]);

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
	// The list is read while the screen is shown; a finished task or a settled delete reads it again.
	const histories = useQuery({
		queryKey: [...root, "histories"],
		enabled: visible,
		queryFn: ({ signal }) => api.histories(signal),
	});
	const [selectedHistoryId, setSelectedHistoryId] = useState<string>();
	const detail = useQuery({
		queryKey: [...root, "history", selectedHistoryId],
		enabled: selectedHistoryId !== undefined,
		retry: (count, error) =>
			!(error instanceof ApiError && error.status === 404) && count < 2,
		queryFn: ({ signal }) => api.history(selectedHistoryId as string, signal),
	});
	const taskStates = useRef<ReadonlyMap<string, string> | null>(null);
	const tasks = source.data?.tasks;
	useEffect(() => {
		if (!tasks) return;
		const before = taskStates.current;
		taskStates.current = new Map(tasks.map((t) => [t.taskId, t.state]));
		if (
			before &&
			tasks.some(
				(t) =>
					ENDED_TASK_STATES.has(t.state) &&
					!ENDED_TASK_STATES.has(before.get(t.taskId) ?? ""),
			)
		)
			void cache.invalidateQueries({ queryKey: [...root, "histories"] });
	}, [tasks, cache, root]);
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
				histories: histories.data,
				selectedHistoryId,
				historyDetail: detail.data,
				historyDetailError: detail.error
					? detail.error instanceof ApiError && detail.error.status === 404
						? "この履歴は見つかりません。削除された可能性があります。"
						: "履歴を読み込めませんでした。"
					: undefined,
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
			histories.data,
			selectedHistoryId,
			detail.data,
			detail.error,
		],
	);

	const refresh = useCallback(
		() => cache.invalidateQueries({ queryKey: root }),
		[cache, root],
	);

	/** Opens a history's detail modal (a read), or closes it with undefined. */
	function selectHistory(historyId: string | undefined) {
		setSelectedHistoryId(historyId);
	}

	/** The history is gone: close its modal and drop its cached detail; the list is read again. */
	function historyDeleted(historyId: string) {
		setSelectedHistoryId(undefined);
		cache.removeQueries({ queryKey: [...root, "history", historyId] });
		void cache.invalidateQueries({ queryKey: [...root, "histories"] });
	}

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
		selectHistory,
		historyDeleted,
	};
}
