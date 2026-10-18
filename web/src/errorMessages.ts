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
	invalid_larm_origin_unconfirmed:
		"LARM の接続先の変更が確認されませんでした。",
	work_busy:
		"専門担当が作業中です。完了を待つか、停止または「会話に戻る」を使ってください。",
	addressee_changed:
		"宛先が変わりました。内容を確認してもう一度送信してください。",
	work_unsaved: "未保存の変更があります。保存するか破棄してください。",
	generation_in_progress: "生成中のため、今は操作できません。",
	save_conflict: "保存作品が別の場所で更新されています。下書きは残っています。",
	composition_in_use:
		"この作品は編集中のため削除できません。保存して会話に戻るか、破棄してから削除してください。",
	target_not_found: "対象が見つかりません。画面を更新してください。",
	undo_limit_reached:
		"元に戻せる変更の上限に達しました。保存すると続けて編集できます。",
	session_ended: "制作は終了しています。",
	session_expired: "制作の期限が切れたため、未保存の案は破棄されました。",
	voice_session_inactive:
		"音声セッションが終了しています。もう一度開始してください。",
	voice_sequence_out_of_order:
		"音声の順序が合わなくなりました。もう一度話してください。",
	voice_sequence_invalid:
		"音声の順序が正しくありません。もう一度話してください。",
	voice_audio_capacity:
		"再生待ちの音声が多すぎます。再生が終わってから話してください。",
	voice_preview_busy: "試聴中です。終わってからもう一度お試しください。",
	stale_voice_generation: "音声セッションが切り替わりました。",
	stale_voice_preview: "試聴の内容が古くなりました。もう一度お試しください。",
	voice_input_stale: "発話の続きが届いたため、文字起こしをまとめ直しています。",
	voice_input_not_ready: "文字起こしがまだ確定していません。",
	voice_input_capacity:
		"文字起こしが長くなりました。マイクを停止して、内容を確認して送信してください。",
	audio_too_large: "音声が長すぎます。短く区切って話してください。",
	audio_empty: "音声が聞き取れませんでした。",
	audio_invalid_wav: "音声データを読み取れませんでした。",
	larm_tts_voice_presentation_unavailable:
		"選んだ日本語の声の種類を確認できません。声の一覧を再取得してください。",
	larm_tts_voice_presentation_mismatch:
		"対応する英語の声の公開情報が一致しないため、読み上げを続けられません。",
	speech_tts_target_unavailable:
		"選択した言語の声を利用できません。音声設定を確認してください。",
	image_invalid: "画像を読み取れません。破損していない画像を選んでください。",
	image_format_unsupported: "対応形式はJPG・PNG・BMPです。",
	image_mime_mismatch:
		"画像の形式とデータが一致しません。保存し直して追加してください。",
	image_not_supported:
		"選択したモデルでは画像を送れません。画像入力対応のLARMモデルを選んでください。",
	image_reference_unsupported: "画像の送信形式が接続先に対応していません。",
	image_role_unsupported: "画像はユーザーの発言に添付してください。",
	image_detail_unsupported: "画像の詳細指定が接続先に対応していません。",
	image_too_large: "画像が大きすぎます。画像を縮小して再度追加してください。",
	image_count_exceeded:
		"過去の画像を含めた枚数が上限を超えました。画像の少ない会話で送信してください。",
	image_dimensions_exceeded:
		"画像の寸法が上限を超えました。画像を縮小してください。",
	body_too_large:
		"本文・履歴・画像の合計が大きすぎます。画像を減らすか縮小してください。",
	context_budget_exceeded:
		"入力がモデルの上限を超えました。本文や画像を減らしてください。",
	chat_token_count_unavailable:
		"入力の容量を確認できなかったため送信を止めました。接続状態を確認してください。",
	chat_input_contract_unavailable:
		"画像入力の接続仕様を確認できなかったため送信を止めました。接続を再確認してください。",
	attachment_not_found: "添付画像が見つかりません。もう一度追加してください。",
	attachment_source_unavailable:
		"会話の画像を取得できません。画像を除いた要求は送信していません。",
	attachment_capacity:
		"未送信画像の保存容量が上限に達しました。時間をおいてお試しください。",
	output_parameter_unsupported: "応答の長さの指定が接続先に対応していません。",
	output_budget_exceeded: "応答の長さがモデルの上限を超えました。",
	gateway_timeout: "画像の応答が時間切れになりました。",
	larm_unconfigured: "LARMが設定されていません。",
	larm_base_url_unconfigured: "LARMの接続先URLが設定されていません。",
	larm_provider_host_mismatch:
		"LARMが示した接続先が許可されていないため中止しました。",
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
	input_ready: "発話を確認中",
	merged: "続きの発話へ結合済み",
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

const domExceptionMessages: Record<string, string> = {
	NotAllowedError:
		"マイクの使用が許可されていません。ブラウザの設定を確認してください。",
	NotFoundError: "マイクが見つかりません。",
	NotReadableError: "マイクを他のアプリが使用中です。",
	OverconstrainedError: "選択したマイクが使えません。",
	AbortError: "操作が中断されました。",
};

const SNAKE_CASE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
/** Only machine codes are shown; English exception text never reaches the UI. */
const unknownError = (text: string) =>
	SNAKE_CASE_CODE.test(text)
		? `エラーが発生しました(コード: ${text})`
		: "エラーが発生しました。";

const code = (value: string) => value.replace(/^(?:\w*Error:\s*)/, "").trim();

/** Maps any thrown value to a Japanese sentence; raw codes never reach the UI alone. */
export function describeError(e: unknown): string {
	if (e instanceof Error || e instanceof DOMException) {
		const byName = domExceptionMessages[e.name];
		if (byName && !(e instanceof ApiError)) return byName;
	}
	if (e instanceof ApiConnectionError) return messages.api_connection_failed!;
	if (e instanceof ApiError) {
		const known = messages[e.message];
		if (known) return known;
		if (e.status === 401 || e.status === 403) return messages.unauthorized!;
		if (e.status === 413) return messages.payload_too_large!;
		return unknownError(e.message);
	}
	const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
	const text = code(raw);
	const known = messages[text];
	if (known) return known;
	return unknownError(text);
}

export const describeTurnStatus = (status: string) =>
	turnStatuses[status] ?? status;

export const describeConnectionState = (state: string) =>
	connectionStates[state] ?? state;
