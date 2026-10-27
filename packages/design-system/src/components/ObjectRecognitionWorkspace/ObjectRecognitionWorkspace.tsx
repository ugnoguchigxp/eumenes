import { VisualAnalysis } from "../VisualAnalysis";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Menu } from "lucide-react";
import { Button } from "../Button";
import { ImagePicker } from "../ImagePicker/ImagePicker";
import { RecognitionHistory } from "./RecognitionHistory";
import {
	CaptureControls,
	HandoffNotice,
	RecognitionStatus,
} from "./CaptureControls";
import { DetectionPreview } from "./DetectionPreview";
import { CaptureSaveNotice } from "./CaptureSaveNotice";
import type { ObjectRecognitionWorkspaceProps } from "./types";
import { useCameraCapture, type CaptureOrigin } from "./useCameraCapture";
/** Seconds between opening the camera for a capture request and taking the still. */
const handoffCountdown = 2;
import "./ObjectRecognitionWorkspace.css";

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
	const [libraryOpen, setLibraryOpen] = useState(false);
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
			<RecognitionHeading
				historyTrigger={historyTrigger}
				historyOpen={historyOpen}
				recording={camera.recording}
				onToggle={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
				onRefresh={props.onRefresh}
			/>
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
			<CaptureSaveNotice {...props} />
			{handoff && (
				<HandoffNotice
					handoff={handoff}
					countdown={countdown}
					retry={retry}
					disabled={disabled}
					camera={camera}
					onTake={() => void takeForHandoff(handoff.id, handoff.source)}
					onDismiss={() => {
						handled.current.add(handoff.id);
						taking.current = null;
						camera.close();
						props.onHandoffCancel?.(handoff.id);
					}}
				/>
			)}
			{libraryOpen && (
				<ImagePicker
					savedOnly
					images={props.libraryImages ?? []}
					loading={props.libraryLoading}
					error={props.libraryError}
					pending={props.busy}
					onRefresh={props.onLibraryRefresh}
					onDelete={props.onLibraryDelete}
					onCancel={() => setLibraryOpen(false)}
					onConfirm={(id) => {
						setLibraryOpen(false);
						camera.close();
						props.onLibrarySelect?.(id);
					}}
				/>
			)}
			{/* Kept mounted behind the picker so a capture request still reaches the camera preview. */}
			<div hidden={libraryOpen}>
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
						<CaptureControls
							camera={camera}
							disabled={disabled}
							processing={processing}
							processingLabel={processingLabel}
							onFile={(file) => void uploading(file, "file")}
							onLibraryOpen={
								props.onLibrarySelect
									? () => {
											camera.close();
											setLibraryOpen(true);
											props.onLibraryRefresh?.();
										}
									: undefined
							}
						/>
					}
					status={
						item ? (
							<RecognitionStatus
								item={item}
								analyzing={analyzing}
								progress={selectedProgress}
								onCancel={props.onCancel}
								onRecheck={props.onRecheck}
							/>
						) : null
					}
				/>
				{item && (
					<VisualAnalysis key={`${item.id}:${props.frameIndex}`} {...props} />
				)}
			</div>
			<details className="recognition-note">
				<summary>検出結果について</summary>
				<p>
					標準80クラスを検出します。動画は毎秒2枚・最大60枚で、フレーム間の出現をすべて拾うとは限りません。scoreは校正済み確率ではありません。同じlabelは同一個体とは限らず、人物の本人・商品型番・行動は特定しません。
				</p>
			</details>
		</section>
	);
}

function RecognitionHeading({
	historyTrigger,
	historyOpen,
	recording,
	onToggle,
	onRefresh,
}: {
	historyTrigger: RefObject<HTMLButtonElement | null>;
	historyOpen: boolean;
	recording: boolean;
	onToggle: () => void;
	onRefresh?: () => void;
}) {
	return (
		<header className="recognition-heading">
			<div className="recognition-heading-main">
				<Button
					ref={historyTrigger}
					variant="outline"
					size="sm"
					aria-haspopup="menu"
					aria-expanded={historyOpen}
					disabled={recording}
					title={
						recording ? "録画を終了してから資料を選んでください。" : undefined
					}
					onClick={onToggle}
				>
					<Menu size={16} />
					資料一覧
				</Button>
				<div>
					<h2>映っている物を調べる</h2>
					<p>カメラの撮影や画像・動画から、映っている物を確認します。</p>
				</div>
			</div>
			<Button variant="secondary" onClick={onRefresh}>
				更新
			</Button>
		</header>
	);
}
