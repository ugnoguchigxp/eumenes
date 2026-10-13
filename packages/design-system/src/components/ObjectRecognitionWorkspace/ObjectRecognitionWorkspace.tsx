import { useState } from "react";
import { Button } from "../Button";
import { CameraCapture } from "./CameraCapture";
import { DetectionPreview } from "./DetectionPreview";
import type { ObjectRecognitionWorkspaceProps, RecognitionItem } from "./types";
import "./ObjectRecognitionWorkspace.css";
const labels = { queued: "準備待ち", starting: "起動待ち・解析中", running: "動画を解析中", cancelling: "取消を確認中", completed: "解析完了", failed: "解析失敗", cancelled: "中止" };
const errors: Record<string, string> = { recognition_busy: "サービスが混雑しています。", recognition_invalid_input: "形式または動画の長さを確認してください。", recognition_input_too_large: "入力が16 MiBを超えています。", recognition_auth_failed: "backendの接続認証を確認してください。", recognition_cancel_unconfirmed: "上流の取消を確認できませんでした。", recognition_submission_unconfirmed: "受付を確認できませんでした。自動再送はしていません。", recognition_connection_changed: "接続設定が変更されました。" };
const stateLabel = (item: RecognitionItem) => item.state === "cancelled" && item.errorCode === "recognition_result_discarded" ? "取消済み（処理終了・結果不採用）" : labels[item.state];
export function ObjectRecognitionWorkspace(props: ObjectRecognitionWorkspaceProps) {
	const [localError, setLocalError] = useState("");
	const item = props.items.find(i => i.id === props.selectedId);
	const uploading = async (file: File) => { setLocalError(""); try { await props.onFile?.(file); } catch { setLocalError("入力を送信できませんでした。接続状態・形式・容量を確認してください。"); } };
	return <section className="recognition-workspace" aria-label="映っている物を調べる">
		<h2>映っている物を調べる</h2><p>画像・動画から物体を検出し、位置と種類を確認できます。</p>
		{!props.configured && <p role="status">物体認識APIの接続設定が必要です。backendの接続先と認証方式を設定してください。</p>}
		<label className="recognition-auth">認証方式 <select aria-label="物体認識の認証方式" value={props.credentialSource ?? "dedicated"} disabled={props.busy || !props.hasEndpoint || !props.onCredentialSourceChange} onChange={e => { const source = e.target.value; if (source === "dedicated" || source === "larm") props.onCredentialSourceChange?.(source); }}>
<option value="dedicated">専用credential</option><option value="larm" disabled={!props.sharedCredentialAvailable}>LARM共有credential</option>
</select></label>
		<div className="recognition-inputs">
			<CameraCapture onCapture={uploading} disabled={props.busy || !props.configured} />
			<label className="recognition-file">画像・動画を選ぶ<input aria-label="画像・動画を選ぶ" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" disabled={props.busy || !props.configured} onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void uploading(file); }} /></label>
			<small>16 MiB・動画30秒まで</small><Button variant="secondary" onClick={props.onRefresh}>更新</Button>
		</div>
		{(localError || props.error) && <p role="alert">{props.error || localError}</p>}
		{props.message && <p role="status">{props.message}</p>}
		{props.items.length > 0 && <label>保存した資料<select aria-label="保存した資料" value={props.selectedId ?? ""} onChange={e => props.onSelect?.(e.target.value)}>{props.items.map(i => <option key={i.id} value={i.id}>{i.name} · {stateLabel(i)}</option>)}</select></label>}
		{item && <div className="recognition-status" role="status"><strong>{stateLabel(item)}</strong>{item.progress !== null && <span>進捗: {JSON.stringify(item.progress)}</span>}
			{["queued", "starting", "running"].includes(item.state) && <Button variant="secondary" onClick={() => props.onCancel?.(item.id)}>取消</Button>}
			{item.state === "failed" && <span>{errors[item.errorCode ?? ""] ?? "サービスに接続できませんでした。"}</span>}
			{item.canRecheck && <Button variant="secondary" onClick={() => props.onRecheck?.(item.id)}>保存した受付から再確認</Button>}
            {["completed", "failed", "cancelled"].includes(item.state) && <Button variant="secondary" onClick={() => props.onRemove?.(item.id)}>資料と結果を削除</Button>}
		</div>}
		{item?.state === "completed" && item.result && props.mediaUrl && <DetectionPreview key={item.id} item={item} url={props.mediaUrl} onIncorporate={i => props.onIncorporate?.(item.id, i)} />}
		{!item && <div className="recognition-empty">カメラで撮影するか、画像・短い動画を選んでください。</div>}
		<p className="recognition-note">標準80クラスを検出します。動画は毎秒2枚・最大60枚で、フレーム間の出現をすべて拾うとは限りません。scoreは校正済み確率ではありません。同じlabelは同一個体とは限らず、人物の本人・商品型番・行動は特定しません。</p>
	</section>;
}
