import "./ImageMedia.css";
import { useState } from "react";
import { Download, ZoomIn, ImageIcon } from "lucide-react";
import { Button } from "../Button";
import {
	GenerationStatus,
	type GenerationStatusProps,
} from "../GenerationStatus";
import { ImageViewer } from "../ImageViewer";
import type { WorkspaceImage } from "./types";
export type ImagePreviewProps = {
	image?: WorkspaceImage;
	status?: GenerationStatusProps["status"];
	title?: string;
	description?: string;
	onCancel?: () => void;
	pending?: boolean;
};
export function ImagePreview({
	image,
	status,
	title,
	description,
	onCancel,
	pending,
}: ImagePreviewProps) {
	const [open, setOpen] = useState(false);
	const [failure, setFailure] = useState<string>();
	return (
		<section className="image-preview" aria-label="画像プレビュー">
			<h3>プレビュー</h3>
			{image ? (
				<>
					{failure === image.url ? (
						<div className="image-preview-frame image-preview-error">
							<p role="alert">画像を読み込めませんでした。</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setFailure(undefined)}
							>
								画像を再読み込み
							</Button>
						</div>
					) : (
						<button
							type="button"
							className="image-preview-frame"
							aria-label={`${image.title}を拡大`}
							onClick={() => setOpen(true)}
						>
							<img
								src={image.url}
								alt={image.title}
								onError={() => setFailure(image.url)}
							/>
						</button>
					)}

					<div className="image-preview-meta">
						<strong>{image.title}</strong>
						<span>
							{image.width} × {image.height} · {image.format.toUpperCase()}
						</span>
					</div>
					<div className="image-preview-actions">
						<a
							className="image-download"
							href={image.url}
							download={`image-${image.id}.${image.format}`}
						>
							<Download aria-hidden="true" />
							ダウンロード
						</a>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={failure === image.url}
							onClick={() => setOpen(true)}
						>
							<ZoomIn aria-hidden="true" />
							拡大
						</Button>
					</div>
				</>
			) : (
				<div className="image-preview-empty">
					<ImageIcon aria-hidden="true" />
					<p>完成した画像をここに表示します。</p>
				</div>
			)}
			{status && (
				<GenerationStatus
					status={status}
					title={title ?? "画像の生成状況"}
					description={description}
					onCancel={onCancel}
					cancelling={pending}
				/>
			)}
			<ImageViewer
				src={image?.url ?? ""}
				alt={image?.title}
				open={open && !!image}
				onOpenChange={setOpen}
			/>
		</section>
	);
}
