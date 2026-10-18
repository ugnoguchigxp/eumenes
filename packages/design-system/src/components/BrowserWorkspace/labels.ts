import type {
	BrowserConnectionEndReason,
	BrowserConnectionState,
	BrowserCaptureRange,
	BrowserCaptureState,
	BrowserTabStatus,
	BrowserTaskState,
	BrowserUnavailableReason,
} from "./types";

export const unavailableLabels: Record<string, string> = {
	browser_not_configured: "Braveの実行ファイルのパスが設定されていません。",
	browser_disconnected: "ブラウザに接続されていません。",
	browser_connect_timeout:
		"接続が時間内に完了しませんでした。もう一度接続してください。",
	browser_mcp_unavailable: "ブラウザ操作の部品を起動できませんでした。",
};

export function unavailableLabel(reason: BrowserUnavailableReason) {
	return unavailableLabels[reason] ?? "現在ブラウザを利用できません。";
}

export const tabStatusLabels: Record<BrowserTabStatus, string> = {
	open: "開いています",
	busy: "作業中",
	lost: "見失いました",
	closed: "閉じました",
	blocked: "保護のため停止",
};

export const blockedTabNote =
	"開けないページのため、操作も切り替えもできません。Braveで別のページに移してください。";

export const connectionStateLabels: Record<BrowserConnectionState, string> = {
	disconnected: "未接続",
	connecting: "接続待ち",
	connected: "接続中",
};

export const connectionEndReasonLabels: Record<string, string> = {
	user_disconnected: "切断しました。",
	browser_closed: "Braveが終了したため接続が終わりました。",
	process_exited: "接続の部品が終了したため接続が終わりました。",
	backend_stopped: "サーバーが停止したため接続が終わりました。",
	connect_timeout: "接続が時間内に完了しませんでした。",
};

export function connectionEndReasonLabel(reason: BrowserConnectionEndReason) {
	return connectionEndReasonLabels[reason] ?? "接続が終わりました。";
}

export const connectingHint =
	"Braveに表示された接続ページで、操作させるタブを選んでください";
export const disconnectedNote =
	"ブラウザに接続すると、タブの操作やURLを開く操作ができます。";

export const taskStateLabels: Record<BrowserTaskState, string> = {
	queued: "待機中",
	running: "実行中",
	completed: "完了",
	needs_input: "入力待ち",
	failed: "失敗",
	cancelled: "取り消し",
	expired: "期限切れ",
	indeterminate: "結果不明",
};

export const captureStateLabels: Record<BrowserCaptureState, string> = {
	queued: "待機中",
	capturing: "撮影中",
	encoding: "変換中",
	local_ready: "撮影済み",
	failed: "失敗",
	cancelled: "取り消し",
	expired: "期限切れ",
};

export const captureRangeLabels: Record<BrowserCaptureRange, string> = {
	viewport: "表示範囲",
	"full-page": "ページ全体",
	element: "要素",
};

export const uploadLabel = "ライブラリー保存: 未対応";

export const taskCancellable = (state: BrowserTaskState) =>
	state === "queued" || state === "running";
export const captureCancellable = (state: BrowserCaptureState) =>
	state === "queued" || state === "capturing" || state === "encoding";

export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatCapturedAt(iso: string) {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return iso;
	return new Intl.DateTimeFormat("ja-JP", {
		timeZone: "Asia/Tokyo",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(time);
}
