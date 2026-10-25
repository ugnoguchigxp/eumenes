import { VisualAnalysis } from "../VisualAnalysis";
import { useEffect, useRef, useState } from "react";
import { Camera, FileUp, ScanText, Video } from "lucide-react";
import { Button } from "../Button";
import { useCameraCapture } from "../ObjectRecognitionWorkspace/useCameraCapture";
import { OcrResult } from "./OcrResult";
import { stateLabels, type OcrWorkspaceProps } from "./types";
import "./ocr.css";
const errors: Record<string, string> = {
	ocr_busy: "OCRサービスが混雑しています。",
	ocr_invalid_input: "ファイル形式か動画の長さを確認してください。",
	ocr_input_too_large: "16 MiBを超えています。",
	ocr_auth_failed:
		"OCRサービスがLARM共通トークンでの認証を拒否しました。接続先とサービス側の認証設定を確認してください。",
	ocr_connection_failed: "OCRサービスに接続できませんでした。",
	ocr_connection_changed: "接続先が変更されました。",
	ocr_submission_unconfirmed:
		"受付を確認できませんでした。自動再送はしていません。",
	ocr_cancel_unconfirmed: "取消の完了を確認できませんでした。",
};
export function OcrPanel(props: OcrWorkspaceProps) {
	const input = useRef<HTMLInputElement>(null);
	const [localError, setLocalError] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [endpoint, setEndpoint] = useState(props.baseUrl ?? "");
	async function upload(file: File) {
		setLocalError("");
		setSubmitting(true);
		try {
			await props.onFile?.(file);
		} catch {
			setLocalError(
				"送信できませんでした。接続状態・形式・容量を確認してください。",
			);
		} finally {
			setSubmitting(false);
		}
	}
	const { preview, ...camera } = useCameraCapture(upload);
	useEffect(() => {
		props.onRecordingChange?.(camera.recording);
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- runs only when the listed value changes
	}, [camera.recording]);
	useEffect(() => {
		camera.close();
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- runs only when the listed value changes
	}, [props.selectedId]);
	const item = props.items.find((i) => i.id === props.selectedId);
	const active =
		item &&
		["queued", "starting", "running", "cancelling"].includes(item.state);
	return (
		<section className="ocr-panel" aria-label="OCR結果と入力">
			{!props.configured && (
				<div className="ocr-connection">
					{!props.baseUrl && (
						<p>
							OCRの接続先が未設定です。Eumenesから接続できるOCRサービスのURLを保存してください。
						</p>
					)}
					<p>
						{props.sharedCredentialAvailable === false
							? "LARM共通トークンを読み込めません。Eumenesのサーバー設定を確認してください。"
							: props.sharedCredentialAvailable === true
								? "認証には設定済みのLARM共通トークンを使います。別のキーの入力は不要です。"
								: "認証にはLARM共通トークンを使います。"}
					</p>
					<label>
						接続先 URL
						<input
							value={endpoint}
							onChange={(e) => setEndpoint(e.target.value)}
							placeholder="http://127.0.0.1:18794/"
						/>
					</label>
					<Button
						onClick={() => props.onConfigure?.(endpoint)}
						disabled={!endpoint || props.busy}
					>
						保存
					</Button>
				</div>
			)}
			<div className="ocr-controls" aria-label="画像・動画の入力">
				<Button
					variant="outline"
					size="icon"
					aria-label="画像・動画ファイルをアップロード"
					title="画像・動画ファイルをアップロード"
					disabled={
						!props.configured || props.busy || submitting || camera.recording
					}
					onClick={() => input.current?.click()}
				>
					<FileUp size={18} />
				</Button>
				<input
					ref={input}
					className="ocr-file-input"
					type="file"
					accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
					tabIndex={-1}
					aria-hidden="true"
					onChange={(e) => {
						const file = e.currentTarget.files?.[0];
						e.currentTarget.value = "";
						if (file) void upload(file);
					}}
				/>
				<Button
					variant="outline"
					size="icon"
					aria-label="カメラを開く"
					title="カメラを開く"
					disabled={!props.configured || props.busy || camera.opened}
					onClick={() => void camera.open()}
				>
					<Camera size={18} />
				</Button>
				{camera.opened && (
					<>
						<Button
							size="sm"
							disabled={camera.recording || submitting}
							onClick={() => void camera.photo()}
						>
							撮影
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={submitting || props.busy}
							onClick={() =>
								camera.recording ? camera.finishRecording() : camera.record()
							}
						>
							<Video size={16} />
							{camera.recording ? "録画を終了" : "録画"}
						</Button>
						<Button variant="ghost" size="sm" onClick={camera.close}>
							カメラを閉じる
						</Button>
					</>
				)}
				<small>
					JPEG・PNG・WebP / MP4・MOV・WebM、16 MiBまで。動画30秒まで。
				</small>
			</div>
			<video
				ref={preview}
				autoPlay
				muted
				playsInline
				hidden={!camera.opened}
				className="ocr-camera"
				aria-label="カメラプレビュー"
			/>
			{(props.error || localError || camera.error) && (
				<p role="alert" className="ocr-message">
					{props.error || localError || camera.error}
				</p>
			)}
			{props.message && (
				<p role="status" className="ocr-message">
					{props.message}
				</p>
			)}
			{item && item.state !== "completed" && (
				<div className="ocr-status" role="status">
					<strong>{stateLabels[item.state]}</strong>
					{item.errorCode && (
						<p>{errors[item.errorCode] ?? "処理に失敗しました。"}</p>
					)}
					{active && item.state !== "cancelling" && (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => props.onCancel?.(item.id)}
						>
							中止
						</Button>
					)}
					{item.canRecheck && (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => props.onRecheck?.(item.id)}
						>
							状態を再確認
						</Button>
					)}
				</div>
			)}
			{item && (
				<VisualAnalysis key={`${item.id}:${props.frameIndex}`} {...props} />
			)}
			{item?.state === "completed" ? (
				<OcrResult
					key={`${item.id}:${props.frameIndex}:${props.correctionPreferredId ?? ""}`}
					{...props}
					item={item}
				/>
			) : (
				!item && (
					<div className="ocr-result-empty">
						<ScanText size={28} aria-hidden="true" />
						<h3>読み取り結果</h3>
						<p>
							画像・動画を選ぶか、カメラで撮影すると、ここに文字を表示します。
						</p>
					</div>
				)
			)}
		</section>
	);
}
