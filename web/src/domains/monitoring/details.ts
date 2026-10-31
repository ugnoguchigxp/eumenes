import type {
	MonitoringItem,
	LarmView,
} from "../../../../api/domains/monitoring/contracts";

const labels: Record<string, string> = {
	unconfigured: "LARM接続が未設定です",
	larm_off_lan: "LARMのあるLANの外にいるため確認していません",
	unreachable: "LARMへ接続できません",
	timeout: "LARMからの取得がタイムアウトしました",
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
	history_gap: "過去の履歴に欠落があります",
	selection_required: "監視する機器を選択してください",
	gpu_unavailable: "GPUの計測情報がありません",
	larm_reported_failure: "LARMが処理の失敗を報告しています",
	measurement_unavailable: "計測値を取得できていません",
	service_connection_unavailable:
		"設定した接続が無効、未設定、または必要な認証情報がありません",
	larm_failed: "LARMの接続を確認できません",
	"host.oom_kill_observed": "メモリ不足による強制終了の記録があります",
	"gpu.reset_observed": "GPUリセットの記録があります",
	"gpu.ring_timeout_observed": "GPUの応答停止の記録があります",
	"gpu.page_fault_observed": "GPUのメモリアクセス障害の記録があります",
	"gpu.execution_fault_observed": "GPUの実行障害の記録があります",
};
const qualities: Record<string, string> = {
	stale: "LARM側の計測更新が遅れています",
	unsupported: "非対応の計測があります",
	permission_denied: "計測権限なし",
	error: "計測に失敗した項目があります",
	unavailable: "未取得の計測があります",
};
const time = (at: number) => new Date(at).toLocaleTimeString();

function historyDetails(view: LarmView): string[] {
	const coverage = view.history.coverage ?? [];
	const available = coverage.filter(
		(c) => c.status === "available" && c.through !== null,
	);
	const through = available.length
		? Math.min(...available.map((c) => Date.parse(c.through!)))
		: null;
	const unsupported = coverage.filter((c) => c.status === "unsupported").length;
	const missing = coverage.filter(
		(c) => c.status !== "available" && c.status !== "unsupported",
	).length;
	const window = view.history.window;
	const incomplete =
		window &&
		coverage.some(
			(c) =>
				c.status === "available" &&
				(c.since === null ||
					c.through === null ||
					c.since > window.from ||
					c.through < window.from),
		);
	return [
		...(through === null ? [] : [`履歴確認: ${time(through)}まで`]),
		...(missing ? [`履歴を確認できない取得元: ${missing}件`] : []),
		...(incomplete ? ["履歴の一部を確認できていません"] : []),
		...(view.history.eventStream?.continuity === "gap"
			? [labels.history_gap!]
			: []),
		...(unsupported ? [`履歴の観測対象外: ${unsupported}件`] : []),
		...(!coverage.length && view.eventsStatus.status === "ok"
			? ["履歴の確認範囲は未取得です"]
			: []),
	];
}

function serviceDetails(
	service: NonNullable<MonitoringItem["state"]["service"]>,
): string[] {
	const route =
		service.mode === "cloud-only"
			? (service.connectionName ?? "クラウド")
			: service.mode === "larm-only"
				? "LARM"
				: service.cloudAllowed
					? "LARM優先（クラウド代替を許可）"
					: "LARM優先";
	return [
		`設定経路: ${route}`,
		...(service.model ? [`設定モデル: ${service.model}`] : []),
		...(service.running ? [`実行中: ${service.running}件`] : []),
		...(service.lastSuccessAt === null
			? []
			: [`直近の成功: ${time(service.lastSuccessAt)}`]),
		...(service.lastFailure
			? [
					`直近の失敗: ${time(service.lastFailure.at)}（${service.lastFailure.reason === "local_timeout" ? "応答待ち時間超過" : "処理失敗"}）`,
				]
			: []),
		...(service.lastSuccessAt === null &&
		!service.lastFailure &&
		!service.running
			? ["直近10分の実行結果はありません"]
			: []),
	];
}

export function monitoringDetails(
	state: MonitoringItem["state"],
	view?: LarmView,
): string[] {
	const notes = [
		...new Set([...(state.diagnostics ?? []), state.reason ?? ""]),
	].flatMap((code) => (labels[code] ? [labels[code]!] : []));
	const unavailable = new Set(state.observations?.map((o) => o.status));
	for (const status of unavailable)
		if (qualities[status]) notes.push(qualities[status]!);
	if (view) notes.push(...historyDetails(view));
	if (state.service) notes.push(...serviceDetails(state.service));
	return [...new Set(notes)];
}
