import { VisualAnalysis } from "../VisualAnalysis";
import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "../Button";
import { RecognitionHistory, stateLabel } from "./RecognitionHistory";
import { DetectionPreview } from "./DetectionPreview";
import type { ObjectRecognitionWorkspaceProps } from "./types";
import { useCameraCapture, type CaptureOrigin } from "./useCameraCapture";
/** Seconds between opening the camera for a capture request and taking the still. */
const handoffCountdown = 2;
import "./ObjectRecognitionWorkspace.css";

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
function progressText(progress: unknown) {
	if (!progress || typeof progress !== "object" || Array.isArray(progress))
		return "";
	const values = progress as Record<string, unknown>;
	const processed = values.processedFrames;
	const total = values.totalFrames;
	return typeof processed === "number" && typeof total === "number"
		? `${processed} / ${total} フレーム`
		: "";
}

export function ObjectRecognitionWorkspace(
	props: ObjectRecognitionWorkspaceProps,
) {
	const [localError, setLocalError] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const historyTrigger = useRef<HTMLButtonElement>(null);
	const item = props.items.find(
		(candidate) => candidate.id === props.selectedId,
	);
	function closeHistory() {
		setHistoryOpen(false);
		historyTrigger.current?.focus();
	}
	const disabled = props.busy || !props.configured;
	/** The capture request the next still answers; cleared once it is taken or dropped. */
	const taking = useRef<string | null>(null);
	const handled = useRef(new Set<string>());
	const [countdown, setCountdown] = useState<number | null>(null);
	/** A request whose still could not be taken; the user can take it again. */
	const [retry, setRetry] = useState<string | null>(null);
	const uploading = async (file: File, origin: CaptureOrigin | "file") => {
		const handoffId = taking.current ?? undefined;
		taking.current = null;
		setLocalError("");
		setSubmitting(true);
		try {
			await props.onFile?.(file, {
				origin,
				...(handoffId ? { handoffId } : {}),
			});
		} catch {
			setLocalError(
				"入力を送信できませんでした。接続状態・形式・容量を確認してください。",
			);
		} finally {
			setSubmitting(false);
		}
	};
	const { preview, ...camera } = useCameraCapture(uploading);
	const handoff = props.handoff;
	const cameraRef = useRef(camera);
	useEffect(() => {
		cameraRef.current = camera;
	});
	// A camera request opens the camera and takes one still after a short countdown; a screen
	// request waits for the user's click because browsers allow screen sharing only on a gesture.
	const cameraHandoff = handoff?.source === "camera" ? handoff.id : undefined;
	useEffect(() => {
		if (!cameraHandoff || handled.current.has(cameraHandoff)) return;
		const id = cameraHandoff;
		const taken = handled.current;
		taken.add(id);
		let live = true;
		let done = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		void cameraRef.current.open("camera").then((opened) => {
			if (!live) return;
			if (!opened) {
				done = true;
				setRetry(id);
				return;
			}
			for (let left = handoffCountdown; left > 0; left--)
				timers.push(
					setTimeout(
						() => setCountdown(left),
						(handoffCountdown - left) * 1000,
					),
				);
			timers.push(
				setTimeout(() => {
					done = true;
					setCountdown(null);
					taking.current = id;
					void cameraRef.current.photo().then((taken) => {
						if (taken) return;
						taking.current = null;
						setRetry(id);
					});
				}, handoffCountdown * 1000),
			);
		});
		return () => {
			live = false;
			timers.forEach(clearTimeout);
			setCountdown(null);
			// An interrupted request (e.g. a remount) is taken again by the next mount.
			if (!done) taken.delete(id);
		};
	}, [cameraHandoff]);
	/** Takes the request's still on a click: the screen (a browser gesture is required) or a camera retry. */
	async function takeForHandoff(id: string, kind: CaptureOrigin) {
		handled.current.add(id);
		setRetry(null);
		if (!(await camera.open(kind))) {
			setRetry(id);
			return;
		}
		// Let the shared surface or camera paint one frame before it is taken.
		await new Promise((resolve) => setTimeout(resolve, 600));
		taking.current = id;
		if (!(await cameraRef.current.photo())) {
			taking.current = null;
			setRetry(id);
		}
	}
	const selectedProgress = item ? progressText(item.progress) : "";
	const analyzing =
		item?.state === "queued" ||
		item?.state === "starting" ||
		item?.state === "running" ||
		item?.state === "cancelling";
	const processing = submitting || props.busy || analyzing;
	const processingLabel = submitting
		? "画像・動画を送信中"
		: item?.state === "queued"
			? "解析を準備中"
			: item?.state === "starting"
				? "解析を開始中"
				: item?.state === "running"
					? "解析中"
					: item?.state === "cancelling"
						? "取消を確認中"
						: "処理中";

	return (
		<section
			className="recognition-workspace"
			aria-label="映っている物を調べる"
		>
			<header className="recognition-heading">
				<div className="recognition-heading-main">
					<Button
						ref={historyTrigger}
						variant="outline"
						size="sm"
						aria-haspopup="menu"
						aria-expanded={historyOpen}
						disabled={camera.recording}
						title={
							camera.recording
								? "録画を終了してから資料を選んでください。"
								: undefined
						}
						onClick={() =>
							historyOpen ? closeHistory() : setHistoryOpen(true)
						}
					>
						<Menu size={16} />
						資料一覧
					</Button>
					<div>
						<h2>映っている物を調べる</h2>
						<p>カメラの撮影や画像・動画から、映っている物を確認します。</p>
					</div>
				</div>
				<Button variant="secondary" onClick={props.onRefresh}>
					更新
				</Button>
			</header>
			{historyOpen && (
				<RecognitionHistory
					items={props.items}
					selectedId={item?.id}
					busy={props.busy}
					onRemove={props.onRemove}
					onSelect={(id) => {
						camera.close();
						props.onSelect?.(id);
						closeHistory();
					}}
					onClose={closeHistory}
				/>
			)}
			{!props.configured && (
				<p role="status" className="recognition-message">
					物体認識APIの接続設定が必要です。backendの接続先と認証方式を設定してください。
				</p>
			)}
			<label className="recognition-auth">
				認証方式
				<select
					aria-label="物体認識の認証方式"
					value={props.credentialSource ?? "dedicated"}
					disabled={
						props.busy || !props.hasEndpoint || !props.onCredentialSourceChange
					}
					onChange={(event) => {
						const source = event.target.value;
						if (source === "dedicated" || source === "larm")
							props.onCredentialSourceChange?.(source);
					}}
				>
					<option value="dedicated">専用credential</option>
					<option value="larm" disabled={!props.sharedCredentialAvailable}>
						LARM共有credential
					</option>
				</select>
			</label>
			{(localError || props.error || camera.error) && (
				<p role="alert" className="recognition-message">
					{props.error || localError || camera.error}
				</p>
			)}
			{props.message && (
				<p role="status" className="recognition-message">
					{props.message}
				</p>
			)}
			{handoff && (
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
							<Button
								disabled={disabled || camera.opened}
								onClick={() => void takeForHandoff(handoff.id, handoff.source)}
							>
								{handoff.source === "screen"
									? "画面を共有して撮影"
									: "撮影し直す"}
							</Button>
						)}
						<Button
							variant="secondary"
							onClick={() => {
								handled.current.add(handoff.id);
								taking.current = null;
								camera.close();
								props.onHandoffCancel?.(handoff.id);
							}}
						>
							撮影しない
						</Button>
					</div>
				</section>
			)}
			<DetectionPreview
				frameIndex={props.frameIndex}
				onFrame={props.onFrame}
				key={item?.id ?? "empty"}
				item={item}
				url={props.mediaUrl}
				cameraActive={camera.opened}
				cameraPreview={
					<video
						ref={preview}
						autoPlay
						muted
						playsInline
						hidden={!camera.opened}
						aria-label="カメラプレビュー"
					/>
				}
				onShowCamera={() => {
					if (!disabled && !camera.opened) void camera.open("camera");
				}}
				onShowResults={camera.close}
				onIncorporate={() => item && props.onIncorporate?.(item.id)}
				controls={
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
							disabled={
								disabled || !camera.opened || camera.recording || processing
							}
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
							className={
								camera.recording ? "recognition-record-button" : undefined
							}
							disabled={disabled || !camera.opened}
							onClick={() =>
								camera.recording ? camera.finishRecording() : camera.record()
							}
						>
							{camera.recording && (
								<span className="recognition-record-dot" aria-hidden="true" />
							)}
							<span>
								{camera.recording ? "録画を終了して調べる" : "録画を開始"}
							</span>
						</Button>
						{camera.opened && (
							<Button variant="ghost" onClick={camera.close}>
								{camera.origin === "screen"
									? "画面共有を終了"
									: "カメラを閉じる"}
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
									if (file) void uploading(file, "file");
								}}
							/>
						</label>
						<small>動画30秒・16 MiBまで</small>
					</section>
				}
				status={
					item ? (
						<div className="recognition-status" role="status">
							<div className="recognition-status-title">
								{analyzing && (
									<span className="recognition-spinner" aria-hidden="true" />
								)}
								<strong>{stateLabel(item)}</strong>
							</div>
							{selectedProgress && <span>{selectedProgress}</span>}
							{["queued", "starting", "running"].includes(item.state) && (
								<Button
									variant="secondary"
									onClick={() => props.onCancel?.(item.id)}
								>
									取消
								</Button>
							)}
							{item.state === "failed" && (
								<span>
									{errors[item.errorCode ?? ""] ??
										"サービスに接続できませんでした。"}
								</span>
							)}
							{item.canRecheck && (
								<Button
									variant="secondary"
									onClick={() => props.onRecheck?.(item.id)}
								>
									保存した受付から再確認
								</Button>
							)}
						</div>
					) : null
				}
			/>
			{item && (
				<VisualAnalysis key={`${item.id}:${props.frameIndex}`} {...props} />
			)}
			<details className="recognition-note">
				<summary>検出結果について</summary>
				<p>
					標準80クラスを検出します。動画は毎秒2枚・最大60枚で、フレーム間の出現をすべて拾うとは限りません。scoreは校正済み確率ではありません。同じlabelは同一個体とは限らず、人物の本人・商品型番・行動は特定しません。
				</p>
			</details>
		</section>
	);
}
