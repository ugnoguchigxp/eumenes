import { useRef, useState, type ReactNode } from "react";
import { Button } from "../Button";
import type { RecognitionItem } from "./types";

export function DetectionPreview({
	item,
	url,
	onIncorporate,
	cameraPreview,
	cameraActive = false,
	onShowCamera,
	onShowResults,
	controls,
	status,
	mediaSelector,
}: {
	item?: RecognitionItem;
	url?: string;
	onIncorporate?: (frameIndex?: number) => void;
	cameraPreview?: ReactNode;
	cameraActive?: boolean;
	onShowCamera?: () => void;
	onShowResults?: () => void;
	controls?: ReactNode;
	status?: ReactNode;
	mediaSelector?: ReactNode;
}) {
	const video = useRef<HTMLVideoElement>(null);
	const [index, setIndex] = useState(0);
	const [atFrame, setAtFrame] = useState(true);
	const result = item?.state === "completed" ? item.result : null;
	const width = result?.kind === "image" ? result.width : result?.video.width;
	const height = result?.kind === "image" ? result.height : result?.video.height;
	const frame = result?.kind === "video" ? result.frames[index] : undefined;
	const objects = result?.kind === "image" ? result.objects : frame?.objects ?? [];
	const hasMedia = !!result && !!url;
	const emptyMessage =
		item?.state === "cancelled"
			? "この資料の解析は中止されました。"
			: item?.state === "failed"
				? "この資料の解析結果を表示できませんでした。"
				: item
					? "この資料の解析結果を待っています。"
					: "カメラで撮影するか、画像・短い動画を選んでください。";

	function seek(next: number) {
		if (result?.kind !== "video" || !result.frames[next]) return;
		setIndex(next);
		setAtFrame(true);
		if (video.current) {
			video.current.pause();
			video.current.currentTime = result.frames[next].timestampSeconds;
		}
	}

	return (
		<div className="recognition-stage">
			<div className="recognition-main">
				{cameraPreview && (
					<div className="recognition-view-tabs" aria-label="表示する映像">
						<button
						type="button"
							aria-pressed={cameraActive}
							onClick={onShowCamera}
						>
							カメラ
						</button>
						<button
						type="button"
							aria-pressed={!cameraActive}
							onClick={onShowResults}
						>
							解析結果
						</button>
					</div>
				)}
				<div className="recognition-viewport">
					<div className="recognition-live" hidden={!cameraActive}>
						{cameraPreview}
						{cameraActive && (
							<span className="recognition-media-tag">ライブプレビュー</span>
						)}
					</div>
					{!cameraActive && hasMedia && (
						<div
							className="recognition-media"
							style={{ aspectRatio: `${width}/${height}` }}
						>
							{result.kind === "image" ? (
								<img src={url} alt={item?.name ?? "解析した画像"} />
							) : (
								<video
									ref={video}
									src={url}
									controls
									controlsList="nofullscreen noremoteplayback"
									disablePictureInPicture
									playsInline
									aria-label="解析した動画"
									onLoadedMetadata={() => seek(index)}
									onTimeUpdate={() => {
										const time = video.current?.currentTime ?? 0;
										const found = result.frames.findIndex(
											(f) => Math.abs(f.timestampSeconds - time) < 0.12,
										);
										setAtFrame(found >= 0);
										if (found >= 0) setIndex(found);
									}}
								/>
							)}
							{atFrame && (
								<svg
									className="recognition-boxes"
									viewBox={`0 0 ${width} ${height}`}
									preserveAspectRatio="xMidYMid meet"
									aria-label="検出枠"
								>
									{objects.map((object, objectIndex) => (
										<g key={objectIndex}>
											<rect
												x={object.box[0]}
												y={object.box[1]}
												width={object.box[2] - object.box[0]}
												height={object.box[3] - object.box[1]}
												fill="none"
												stroke="var(--recognition-accent, #087f8c)"
												strokeWidth={Math.max(width! / 350, 2)}
											/>
											<text
												x={object.box[0] + 3}
												y={Math.max(object.box[1] + width! / 40, width! / 40)}
												fontSize={width! / 40}
												fill="#fff"
												stroke="#065663"
												strokeWidth={width! / 800}
												paintOrder="stroke"
											>
												{object.label}
											</text>
										</g>
									))}
								</svg>
							)}
							<span className="recognition-media-tag">撮影済みの資料・解析結果</span>
						</div>
					)}
					{!cameraActive && !hasMedia && (
						<div className="recognition-empty">
							{emptyMessage}
						</div>
					)}
				</div>
				{!cameraActive && result?.kind === "video" && (
					<div className="recognition-times" aria-label="動画の検出時刻">
						{result.frames.map((observed, frameIndex) => (
							<Button
								key={frameIndex}
								variant="secondary"
								aria-pressed={frameIndex === index}
								onClick={() => seek(frameIndex)}
							>
								{observed.timestampSeconds.toFixed(1)}秒 · {observed.objects.length}件
							</Button>
						))}
					</div>
				)}
				{!cameraActive && result?.kind === "video" && !atFrame && (
					<p className="recognition-frame-note">
						この再生時刻の検出枠はありません。時刻ボタンで観測したフレームへ移動できます。
					</p>
				)}
				{mediaSelector}
			</div>
			<aside className="recognition-side">
				{controls}
				{status}
				<section className="recognition-list" aria-label="検出された物の一覧">
					<h3>
						{item ? "選択中の資料で見つかった物" : "見つかった物"}
						{frame ? `（${frame.timestampSeconds}秒）` : ""}
					</h3>
					{!result ? (
						<p>解析が完了すると、ここに物体が表示されます。</p>
					) : !objects.length ? (
						<p>検出対象は見つかりませんでした。</p>
					) : (
						<ul>
							{objects.map((object, objectIndex) => (
								<li key={objectIndex}>
									<strong>{object.label}</strong>
									<span>score {object.confidence.toFixed(3)}</span>
									<details>
										<summary>座標を見る</summary>
										<span>[{object.box.join(", ")}]</span>
									</details>
								</li>
							))}
						</ul>
					)}
					<Button
						onClick={() => onIncorporate?.(result?.kind === "video" ? index : undefined)}
						disabled={!onIncorporate || !result}
					>
						{cameraActive
							? "直前の解析結果を会話に追加"
							: "表示中の結果を会話に追加"}
					</Button>
				</section>
			</aside>
		</div>
	);
}
