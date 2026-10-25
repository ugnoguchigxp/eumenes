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

/** Domain refusals in the words of the screen; other codes fall back to the host's wording. */
const rejections: Record<string, string> = {
	browser_not_configured:
		"Braveの実行ファイルのパスが設定されていません。先にパスを保存してください。",
	browser_disconnected: "ブラウザに接続されていません。",
	browser_tab_not_found:
		"そのタブは見つかりません。タブ一覧を確認してください。",
	browser_capture_not_found: "その撮影は見つかりません。",
	browser_task_not_found: "その操作は見つかりません。",
	tab_lost: "対象のタブが見つかりません。タブ一覧を取り直してください。",
	tab_busy: "このタブは別の作業が使っています。",
	tab_blocked: "このタブは開けないページを表示しているため使えません。",
	browser_capacity: "同時に実行できる件数に達しています。",
};

/**
 * The browser screen: connect, disconnect, tab and capture actions are writes through the common
 * action host; only saving the Brave path (a setting, not an action) goes to the browser API.
 */
export const browserWebAdapter: WebArtifactAdapter = {
	adapterRef: BROWSER_ADAPTER_REF,
	useArtifact({ client, artifactRevisionId, visible, conversationId }) {
		const { resource, loading, error, local, refresh } = useBrowserRuntime({
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
			// A connection or tab write changed what the source reports.
			settled: () => {
				void refresh();
			},
			refresh: () => {
				void refresh();
			},
			describeRejection: (code) => (code ? rejections[code] : undefined),
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
