import { useState } from "react";
import { Download, ImageIcon, ZoomIn } from "lucide-react";
import { Button } from "../Button";
import { ImageViewer } from "../ImageViewer";
import {
	captureCancellable,
	captureRangeLabels,
	captureStateLabels,
	formatBytes,
	formatCapturedAt,
	uploadLabel,
} from "./labels";
import type { BrowserCaptureItem } from "./types";

export type BrowserCaptureListProps = {
	captures: readonly BrowserCaptureItem[];
	selectedCaptureId?: string;
	previewSrc?: string;
	disabled?: boolean;
	onSelectCapture: (captureId: string) => void;
	onDownloadCapture: (captureId: string) => void;
	onCancelCapture: (captureId: string) => void;
};

const tones: Record<BrowserCaptureItem["state"], string> = {
	queued: "neutral",
	capturing: "info",
	encoding: "info",
	local_ready: "success",
	failed: "danger",
	cancelled: "muted",
	expired: "muted",
};

function describe(capture: BrowserCaptureItem) {
	return `${captureRangeLabels[capture.range]} ${formatCapturedAt(capture.capturedAt)}`;
}

/** 撮影の一覧と選択中の画像。LARM保存は未対応の固定ラベルだけを出す。 */
export function BrowserCaptureList({
	captures,
	selectedCaptureId,
	previewSrc,
	disabled,
	onSelectCapture,
	onDownloadCapture,
	onCancelCapture,
}: BrowserCaptureListProps) {
	const [open, setOpen] = useState(false);
	const [failedSrc, setFailedSrc] = useState<string>();
	const selected = captures.find(
		(capture) => capture.captureId === selectedCaptureId,
	);
	const showImage = selected?.state === "local_ready" && !!previewSrc;
	return (
		<section className="browser-workspace-section" aria-label="撮影した画像">
			<h3>
				撮影した画像 <span>{captures.length}枚</span>
			</h3>
			{captures.length === 0 ? (
				<p className="browser-workspace-empty">撮影した画像はありません。</p>
			) : (
				<ul className="browser-workspace-list">
					{captures.map((capture) => (
						<li
							key={capture.captureId}
							className="browser-workspace-item"
							data-selected={
								capture.captureId === selectedCaptureId || undefined
							}
							data-state={capture.state}
						>
							<button
								type="button"
								className="browser-workspace-item-main browser-workspace-select"
								aria-pressed={capture.captureId === selectedCaptureId}
								aria-label={`${describe(capture)}を選ぶ`}
								onClick={() => onSelectCapture(capture.captureId)}
							>
								<strong>{describe(capture)}</strong>
								<span>
									{capture.width} × {capture.height} px ·{" "}
									{formatBytes(capture.bytes)} · 削減{" "}
									{Math.round(capture.reductionPercent)}%
								</span>
								<span className="browser-workspace-upload">{uploadLabel}</span>
							</button>
							<div className="browser-workspace-badges">
								<span
									className="browser-workspace-badge"
									data-tone={tones[capture.state]}
								>
									{captureStateLabels[capture.state]}
								</span>
							</div>
							{captureCancellable(capture.state) && (
								<div className="browser-workspace-actions">
									<Button
										type="button"
										variant="outline"
										size="sm"
										aria-label={`${describe(capture)}の撮影を取り消す`}
										disabled={disabled}
										onClick={() => onCancelCapture(capture.captureId)}
									>
										取り消す
									</Button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
			<div className="browser-workspace-preview" aria-label="画像プレビュー">
				{selected && showImage ? (
					<>
						{failedSrc === previewSrc ? (
							<p role="alert">画像を読み込めませんでした。</p>
						) : (
							<button
								type="button"
								className="browser-workspace-preview-frame"
								aria-label="撮影画像を拡大"
								onClick={() => setOpen(true)}
							>
								<img
									src={previewSrc}
									alt={`撮影画像 ${describe(selected)}`}
									onError={() => setFailedSrc(previewSrc)}
								/>
							</button>
						)}
						<div className="browser-workspace-actions">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => onDownloadCapture(selected.captureId)}
							>
								<Download aria-hidden="true" />
								ダウンロード
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={failedSrc === previewSrc}
								onClick={() => setOpen(true)}
							>
								<ZoomIn aria-hidden="true" />
								拡大
							</Button>
						</div>
					</>
				) : (
					<div className="browser-workspace-empty">
						<ImageIcon aria-hidden="true" />
						<p>
							{selected && selected.state !== "local_ready"
								? "撮影が終わるとここに表示します。"
								: "画像を選ぶとここに表示します。"}
						</p>
					</div>
				)}
			</div>
			<ImageViewer
				src={showImage ? previewSrc : ""}
				alt={selected ? `撮影画像 ${describe(selected)}` : undefined}
				open={open && showImage}
				onOpenChange={setOpen}
			/>
		</section>
	);
}
