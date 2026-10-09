import { ApiConnectionError, ApiError } from "../../client/transport";

const messages: Record<string, string> = {
	invalid_input: "入力内容が正しくありません。",
	request_conflict:
		"同じ操作が別の内容で実行済みです。画面を更新してください。",
	revision_conflict: "別の場所で変更されています。最新の状態を読み込みました。",
	database_writer_queue_full:
		"処理が混み合っています。少し待ってからもう一度お試しください。",
	queue_full: "処理が混み合っています。少し待ってからもう一度お試しください。",
	api_connection_failed:
		"APIに接続できません。バックエンドが起動しているか確認してください。",
	unauthorized: "認証に失敗しました。設定を確認してください。",
	payload_too_large: "送信するデータが大きすぎます。",
	env_ref_not_allowed: "この環境変数は認証情報として使用できません。",
	invalid_env_ref: "この環境変数は認証情報として指定できません。",
	voice_session_inactive:
		"音声セッションが終了しています。もう一度開始してください。",
	voice_sequence_out_of_order:
		"音声の順序が合わなくなりました。もう一度話してください。",
	voice_sequence_invalid:
		"音声の順序が正しくありません。もう一度話してください。",
	voice_preview_busy: "試聴中です。終わってからもう一度お試しください。",
	stale_voice_generation: "音声セッションが切り替わりました。",
	stale_voice_preview: "試聴の内容が古くなりました。もう一度お試しください。",
	audio_too_large: "音声が長すぎます。短く区切って話してください。",
	audio_empty: "音声が聞き取れませんでした。",
	audio_invalid_wav: "音声データを読み取れませんでした。",
	asr_language_not_allowed: "設定で許可されていない言語です。",
	larm_unconfigured: "LARMが設定されていません。",
	permission_revoked: "接続の権限が取り消されました。",
	timeout: "応答がタイムアウトしました。",
	replay_failed: "読み上げに失敗しました。",
	sample_failed: "サンプルの再生に失敗しました。",
	mic_lost: "マイクが切断されました。音声を再開してください。",
	saved_device_missing:
		"保存されたマイクが見つからないため、既定のマイクを使用します。",
	audio_context_lost: "音声出力が停止しました。音声を再開してください。",
};

const turnStatuses: Record<string, string> = {
	recognizing: "聞き取り中",
	responding: "回答を生成中",
	synthesizing: "音声を合成中",
	ready: "再生待ち",
	played: "再生済み",
	completed: "完了",
	failed: "失敗",
	cancelled: "中止",
	interrupted: "中断",
};

const connectionStates: Record<string, string> = {
	connecting: "接続中",
	ready: "接続済み",
	failed: "接続失敗",
	disconnected: "切断",
	degraded: "一部制限",
	unconfigured: "未設定",
	idle: "待機中",
};

const code = (value: string) => value.replace(/^(?:\w*Error:\s*)/, "").trim();

/** Maps any thrown value to a Japanese sentence; raw codes never reach the UI alone. */
export function describeError(e: unknown): string {
	if (e instanceof ApiConnectionError) return messages.api_connection_failed!;
	if (e instanceof ApiError) {
		const known = messages[e.message];
		if (known) return known;
		if (e.status === 401 || e.status === 403) return messages.unauthorized!;
		if (e.status === 413) return messages.payload_too_large!;
		return `エラーが発生しました(${e.message || e.status})`;
	}
	const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
	const text = code(raw);
	const known = messages[text];
	if (known) return known;
	return text
		? `エラーが発生しました(${text.slice(0, 80)})`
		: "エラーが発生しました。";
}

export const describeTurnStatus = (status: string) =>
	turnStatuses[status] ?? status;

export const describeConnectionState = (state: string) =>
	connectionStates[state] ?? state;
