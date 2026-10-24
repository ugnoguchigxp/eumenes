import type { MonitoringItem } from "../../../../api/domains/monitoring/contracts";

const labels: Record<string, string> = {
	unconfigured: "LARM接続が未設定です",
	larm_off_lan: "LARMのあるLANの外にいるため確認していません",
	unreachable: "LARMへ接続できません",
	timeout: "LARMの応答を待っています",
	unauthorized: "LARMの認証を確認してください",
	forbidden: "監視情報を読む権限がありません",
	not_found: "LARMの監視APIが提供されていません",
	unsupported_contract: "監視APIの版が対応していません",
	rate_limited: "取得が制限されています。次回の更新を待ちます",
	unavailable: "監視情報を現在取得できません",
	invalid_response: "監視情報の形式を確認できません",
	http_error: "監視APIがエラーを返しました",
	not_requested: "監視情報の取得前です",
	catching_up: "出来事の履歴を取得中です",
	epoch_mismatch:
		"LARMの再起動前後の情報が混在しています。次回更新で確認します",
	history_incomplete: "出来事を確認できていない期間があります",
	history_gap: "過去の履歴に欠落があります",
	selection_required: "監視する機器を選択してください",
	gpu_unavailable: "GPUの計測情報がありません",
	larm_reported_failure: "LARMが処理の失敗を報告しています",
	"host.oom_kill_observed": "メモリ不足による強制終了の記録があります",
	"gpu.reset_observed": "GPUリセットの記録があります",
	"gpu.ring_timeout_observed": "GPUの応答停止の記録があります",
	"gpu.page_fault_observed": "GPUのメモリアクセス障害の記録があります",
	"gpu.execution_fault_observed": "GPUの実行障害の記録があります",
};
const qualities: Record<string, string> = {
	ok: "取得済み",
	stale: "古い参考値",
	unsupported: "計測非対応",
	permission_denied: "計測権限なし",
	error: "計測失敗",
	unavailable: "未取得",
};
export function monitoringDetails(
	state: MonitoringItem["state"],
	elapsed: number,
): string[] {
	const notes = [
		...new Set([...(state.diagnostics ?? []), state.reason ?? ""]),
	].flatMap((code) => (labels[code] ? [labels[code]!] : []));
	for (const o of state.observations ?? []) {
		const age = o.ageMs + elapsed;
		notes.push(
			`${qualities[o.status]}${o.observedAt === null ? "" : ` · ${new Date(o.observedAt).toLocaleString()}（${Math.floor(age / 1000)}秒前）`}${o.observedAt !== null && age > o.maxAgeMs ? " · 有効期限を超えています" : ""}`,
		);
	}
	return notes;
}
