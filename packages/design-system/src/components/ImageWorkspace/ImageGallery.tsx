import "./ImageMedia.css";
import { useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../Button";
import { ImageViewer } from "../ImageViewer";
import { Modal } from "../Modal";
import type { WorkspaceImage } from "./types";
export type ImageGalleryProps = {
	images: WorkspaceImage[];
	selectedId?: string;
	pending?: boolean;
	loading?: boolean;
	error?: string;
	message?: string;
	onRefresh: () => void;
	onSelect: (id: string) => void;
	onDelete?: (id: string) => void;
};
export function ImageGallery({
	images,
	selectedId,
	pending,
	loading,
	error,
	message,
	onRefresh,
	onSelect,
	onDelete,
}: ImageGalleryProps) {
	const [order, setOrder] = useState("desc");
	const [preview, setPreview] = useState<WorkspaceImage>();
	const [failed, setFailed] = useState<Record<string, string>>({});
	const [deleteId, setDeleteId] = useState<string>();
	const target = images.find((image) => image.id === deleteId);
	const visiblePreview = images.find((image) => image.id === preview?.id);
	const sorted = images
		.slice()
		.sort(
			(a, b) =>
				(Date.parse(a.createdAt) - Date.parse(b.createdAt)) *
				(order === "asc" ? 1 : -1),
		);
	return (
		<section className="image-gallery" aria-label="生成した画像">
			<div className="image-gallery-toolbar">
				<h3>
					生成した画像 <span>{images.length}枚</span>
				</h3>
				<div>
					<Button
						type="button"
						variant="outline"
						size="icon"
						aria-label="一覧を更新"
						onClick={() => {
							setFailed({});
							onRefresh();
						}}
						disabled={pending || loading}
					>
						<RefreshCw aria-hidden="true" />
					</Button>
					<select
						aria-label="画像の並び順"
						value={order}
						onChange={(event) => setOrder(event.target.value)}
					>
						<option value="desc">新しい順</option>
						<option value="asc">古い順</option>
					</select>
				</div>
			</div>
			{error && <p role="alert">{error}</p>}
			{message && <output aria-live="polite">{message}</output>}
			{loading && <output>画像を読み込み中です。</output>}
			{!images.length && !loading && !error && (
				<p className="image-gallery-empty">まだ保存された画像はありません。</p>
			)}
			<div className="image-gallery-grid">
				{sorted.map((image) => (
					<article
						key={image.id}
						className="image-gallery-card"
						data-selected={image.id === selectedId}
					>
						<button
							type="button"
							className="image-gallery-thumbnail"
							aria-label={`${image.title}を表示`}
							onClick={() => {
								onSelect(image.id);
								setPreview(image);
							}}
							disabled={failed[image.id] === image.url}
						>
							{failed[image.id] === image.url ? (
								<span role="alert">画像を読み込めませんでした。</span>
							) : (
								<img
									src={image.url}
									alt={image.title}
									loading="lazy"
									onError={() =>
										setFailed((previous) => ({
											...previous,
											[image.id]: image.url,
										}))
									}
								/>
							)}
						</button>
						<div className="image-gallery-caption">
							<div>
								<h4>{image.title}</h4>
								<p>
									<time dateTime={image.createdAt}>
										{new Date(image.createdAt).toLocaleDateString("ja-JP")}
									</time>
									<span>
										{image.width} × {image.height}
									</span>
								</p>
							</div>
							<div className="image-gallery-actions">
								<a
									className="image-download"
									href={image.url}
									download={`image-${image.id}.${image.format}`}
									aria-label={`${image.title}をダウンロード`}
								>
									<Download aria-hidden="true" />
								</a>
								{onDelete && (
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label={`${image.title}を削除`}
										disabled={pending || loading}
										onClick={() => setDeleteId(image.id)}
									>
										<Trash2 aria-hidden="true" />
									</Button>
								)}
							</div>
						</div>
					</article>
				))}
			</div>
			<ImageViewer
				src={visiblePreview?.url ?? ""}
				alt={visiblePreview?.title}
				open={!!visiblePreview}
				onOpenChange={(open) => {
					if (!open) setPreview(undefined);
				}}
			/>
			<Modal
				open={!!target && !!onDelete}
				title="画像を削除しますか？"
				description="保存した画像を完全に削除します。この操作は取り消せません。"
				onOpenChange={(open) => {
					if (!open) setDeleteId(undefined);
				}}
			>
				<p>「{target?.title}」</p>
				<div className="image-gallery-delete-actions">
					<Button
						type="button"
						variant="secondary"
						onClick={() => setDeleteId(undefined)}
					>
						キャンセル
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={pending || loading || !target}
						onClick={() => {
							if (target) {
								onDelete?.(target.id);
								setDeleteId(undefined);
							}
						}}
					>
						削除する
					</Button>
				</div>
			</Modal>
		</section>
	);
}
