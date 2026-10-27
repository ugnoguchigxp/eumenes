import { Button } from "../Button";
import { stateLabel } from "./RecognitionHistory";
import type { RecognitionItem } from "./types";
import type { CaptureOrigin, useCameraCapture } from "./useCameraCapture";

export type CameraControls = Omit<
	ReturnType<typeof useCameraCapture>,
	"preview"
>;

const errors: Record<string, string> = {
	recognition_busy: "サービスが混雑しています。",
	recognition_invalid_input: "形式または動画の長さを確認してください。",
	recognition_input_too_large: "入力が16 MiBを超えています。",
	recognition_auth_failed: "backendの接続認証を確認してください。",
	recognition_cancel_unconfirmed: "上流の取消を確認できませんでした。",
	recognition_submission_unconfirmed:
		"画像・動画は保存済みです。解析サービスへの受付を確認できませんでした。接続状態を確認してください。自動再送はしていません。",
	recognition_connection_failed:
		"画像・動画は保存済みですが、解析サービスに接続できませんでした。",
	recognition_connection_changed: "接続設定が変更されました。",
};

/** The conversation's capture request: shows the countdown and the take / dismiss actions. */
export function HandoffNotice({
	handoff,
	countdown,
	retry,
	disabled,
	camera,
	onTake,
	onDismiss,
}: {
	handoff: { id: string; source: CaptureOrigin; question: string };
	countdown: number | null;
	retry: string | null;
	disabled: boolean;
	camera: CameraControls;
	onTake: () => void;
	onDismiss: () => void;
}) {
	return (
		<section
			className="recognition-handoff"
			role="status"
			aria-label="会話からの撮影依頼"
		>
			<strong>
				{handoff.source === "camera"
					? countdown
						? `${countdown}秒後に撮影します`
						: "カメラで撮影して会話に見せます"
					: "画面を撮影して会話に見せます"}
			</strong>
			{handoff.question && <span>{handoff.question}</span>}
			<div className="recognition-handoff-actions">
				{(handoff.source === "screen" || retry === handoff.id) && (
					<Button disabled={disabled || camera.opened} onClick={onTake}>
						{handoff.source === "screen" ? "画面を共有して撮影" : "撮影し直す"}
					</Button>
				)}
				<Button variant="secondary" onClick={onDismiss}>
					撮影しない
				</Button>
			</div>
		</section>
	);
}

export function CaptureControls({
	camera,
	disabled,
	processing,
	processingLabel,
	onFile,
}: {
	camera: CameraControls;
	disabled: boolean;
	processing: boolean;
	processingLabel: string;
	onFile: (file: File) => void;
}) {
	return (
		<section className="recognition-capture-card" aria-label="撮影・録画">
			<h3>撮影・録画</h3>
			{!camera.opened && (
				<div className="recognition-open-buttons">
					<Button
						variant="secondary"
						disabled={disabled}
						onClick={() => void camera.open("camera")}
					>
						カメラを開く
					</Button>
					<Button
						variant="secondary"
						disabled={disabled}
						onClick={() => void camera.open("screen")}
					>
						画面を共有
					</Button>
				</div>
			)}
			<Button
				className={processing ? "recognition-submit-loading" : undefined}
				aria-busy={processing}
				disabled={disabled || !camera.opened || camera.recording || processing}
				onClick={() => void camera.photo()}
			>
				{processing && (
					<span className="recognition-spinner" aria-hidden="true" />
				)}
				<span aria-live="polite">
					{processing ? processingLabel : "撮影して調べる"}
				</span>
			</Button>
			<Button
				variant="secondary"
				className={camera.recording ? "recognition-record-button" : undefined}
				disabled={disabled || !camera.opened}
				onClick={() =>
					camera.recording ? camera.finishRecording() : camera.record()
				}
			>
				{camera.recording && (
					<span className="recognition-record-dot" aria-hidden="true" />
				)}
				<span>{camera.recording ? "録画を終了して調べる" : "録画を開始"}</span>
			</Button>
			{camera.opened && (
				<Button variant="ghost" onClick={camera.close}>
					{camera.origin === "screen" ? "画面共有を終了" : "カメラを閉じる"}
				</Button>
			)}
			<label className="recognition-file">
				画像・動画を選ぶ
				<input
					aria-label="画像・動画を選ぶ"
					type="file"
					accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
					disabled={disabled}
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						event.currentTarget.value = "";
						if (file) onFile(file);
					}}
				/>
			</label>
			<small>動画30秒・16 MiBまで</small>
		</section>
	);
}

export function RecognitionStatus({
	item,
	analyzing,
	progress,
	onCancel,
	onRecheck,
}: {
	item: RecognitionItem;
	analyzing: boolean;
	progress: string;
	onCancel?: (id: string) => void;
	onRecheck?: (id: string) => void;
}) {
	return (
		<div className="recognition-status" role="status">
			<div className="recognition-status-title">
				{analyzing && (
					<span className="recognition-spinner" aria-hidden="true" />
				)}
				<strong>{stateLabel(item)}</strong>
			</div>
			{progress && <span>{progress}</span>}
			{["queued", "starting", "running"].includes(item.state) && (
				<Button variant="secondary" onClick={() => onCancel?.(item.id)}>
					取消
				</Button>
			)}
			{item.state === "failed" && (
				<span>
					{errors[item.errorCode ?? ""] ?? "サービスに接続できませんでした。"}
				</span>
			)}
			{item.canRecheck && (
				<Button variant="secondary" onClick={() => onRecheck?.(item.id)}>
					保存した受付から再確認
				</Button>
			)}
		</div>
	);
}
