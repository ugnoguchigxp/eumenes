import { useEffect, useRef, useState } from "react";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import { focusWhenDrawn } from "../../components/domains/resource-focus";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { browserApiFor } from "./api";
import { BROWSER_SOURCE } from "./contracts";
import { useBrowserRuntime } from "./use-browser-runtime";

export const BROWSER_ADAPTER_REF = "adapter:browser@1";

/** What the mounted browser screen holds, read through the latest render. */
type BrowserScreen = {
	captureIds: ReadonlySet<string>;
	visible: boolean;
	show(captureId: string): void;
};
const live = createLiveScreen<{ read(): BrowserScreen }>();

const captureItems = () =>
	document.querySelectorAll<HTMLElement>(
		".browser-workspace li[data-capture-id]",
	);
const findCapture = (captureId: string) =>
	[...captureItems()].find(
		(item) => item.getAttribute("data-capture-id") === captureId,
	) ?? null;

const HISTORY_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Domain refusals in the words of the screen; other codes fall back to the host's wording. */
const rejections: Record<string, string> = {
	browser_not_configured:
		"Braveの実行ファイルのパスが設定されていません。先にパスを保存してください。",
	browser_disconnected: "ブラウザに接続されていません。",
	browser_tab_not_found:
		"そのタブは見つかりません。タブ一覧を確認してください。",
	browser_capture_not_found: "その撮影は見つかりません。",
	browser_task_not_found: "その操作は見つかりません。",
	browser_history_not_found:
		"その履歴は見つかりません。削除された可能性があります。一覧を読み直しました。",
	browser_history_conflict:
		"履歴が更新されていました。最新の内容を読み直しました。確認してからもう一度削除してください。",
	replay_busy: "別のリプレイまたはブラウザ操作を実行中です。",
	replay_values_invalid: "変数の値を確かめてください。",
	replay_incomplete: "記録されていない操作や値があるため実行できません。",
	replay_code_rejected: "このコードは安全のため実行できません。",
	replay_destination_blocked: "開けない移動先が含まれています。",
	browser_replay_not_found:
		"そのリプレイは見つかりません。一覧を読み直しました。",
	replay_not_running: "そのリプレイはすでに終わっています。",
	tab_lost: "対象のタブが見つかりません。タブ一覧を取り直してください。",
	tab_busy: "このタブは別の作業が使っています。",
	tab_blocked: "このタブは開けないページを表示しているため使えません。",
	browser_capacity: "同時に実行できる件数に達しています。",
};

/** Refusals that mean the screen shows stale data: it is read again, and the write never resent. */
const refreshedRejections: ReadonlySet<string> = new Set([
	"browser_history_conflict",
	"browser_history_not_found",
	"replay_busy",
	"replay_values_invalid",
	"replay_incomplete",
	"replay_code_rejected",
	"replay_destination_blocked",
	"browser_replay_not_found",
	"replay_not_running",
]);

/**
 * The browser screen: connect, disconnect, tab and capture actions are writes through the common
 * action host; only saving the Brave path (a setting, not an action) goes to the browser API.
 */
export const browserWebAdapter: WebArtifactAdapter = {
	adapterRef: BROWSER_ADAPTER_REF,
	useArtifact({ client, artifactRevisionId, visible, conversationId }) {
		const {
			resource,
			loading,
			error,
			local,
			refresh,
			selectHistory,
			historyDeleted,
		} = useBrowserRuntime({
			client,
			api: browserApiFor(client),
			artifactRevisionId,
			visible,
			conversationId,
		});
		// A capture the conversation asked to show; the screen opens its captures and selects it.
		const [focus, setFocus] = useState<{ seq: number; captureId: string }>();
		const screen: BrowserScreen = {
			captureIds: new Set(resource.captures.map((c) => c.captureId)),
			visible,
			show: (captureId) =>
				setFocus((previous) => ({
					seq: (previous?.seq ?? 0) + 1,
					captureId,
				})),
		};
		const latest = useRef(screen);
		useEffect(() => {
			latest.current = screen;
		});
		useEffect(() => live.attach({ read: () => latest.current }), []);
		return {
			phase: error
				? { kind: "error", message: "ブラウザの情報を取得できませんでした。" }
				: loading
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: {
				[BROWSER_SOURCE]: focus
					? Object.assign({}, resource, { focus })
					: resource,
			},
			targetOf: () => undefined,
			local: (_binding, event) => local(event),
			// Opening or closing a history's detail is a read of the screen's own source.
			sourceRead: (event) => {
				if (event.action !== "browser-select-history") return null;
				const id = event.values.historyId;
				if (typeof id !== "string" || (id !== "" && !HISTORY_ID.test(id)))
					return Promise.resolve({
						status: "rejected",
						message: "この操作は受け付けられません。",
					});
				selectHistory(id || undefined);
				return Promise.resolve({ status: "accepted", message: "" });
			},
			// A connection, tab or history write changed what the source reports.
			settled: (binding, _result, _timing, input) => {
				const deleted = (input as { historyId?: unknown } | undefined)
					?.historyId;
				if (
					binding.eventAction === "browser-delete-history" &&
					typeof deleted === "string"
				)
					historyDeleted(deleted);
				void refresh();
			},
			refresh: () => {
				void refresh();
			},
			describeRejection: (code) => {
				// The list, the open detail and the replays are stale; read them again and never resend.
				if (code && refreshedRejections.has(code)) void refresh();
				return code ? rejections[code] : undefined;
			},
		};
	},
	async focus(captureId) {
		const known = await live.waitFor((handle) =>
			handle.read().captureIds.has(captureId),
		);
		if (!known) return false;
		live.current()?.read().show(captureId);
		// The capture exists; marking it is best effort while the screen draws its captures.
		await focusWhenDrawn(() => findCapture(captureId));
		return true;
	},
	viewing() {
		if (!live.current()?.read().visible) return null;
		const selected = document.querySelector<HTMLElement>(
			".browser-workspace li[data-capture-id][data-selected]",
		);
		const captureId = selected?.getAttribute("data-capture-id");
		return captureId ? formatResourceUri("capture", captureId) : null;
	},
};
