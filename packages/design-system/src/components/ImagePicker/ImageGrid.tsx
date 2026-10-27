import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import "./ImagePicker.css";

const pageSize = 20;

export type ImageGridItem = {
	id: string;
	title: string;
	thumbnailUrl?: string;
	disabledReason?: string;
};

/** Presentation only: selection, preview and management are separate host actions. */
export function ImageGrid<T extends ImageGridItem>({
	images,
	mode = "select",
	selectedId,
	disabled,
	onSelect,
	onPreview,
	selectLabel = (image) => `${image.title}を選ぶ`,
	renderCaption,
	renderActions,
	classNames,
}: {
	images: readonly T[];
	mode?: "view" | "select";
	selectedId?: string;
	disabled?: boolean;
	onSelect: (id: string) => void;
	onPreview?: (id: string) => void;
	selectLabel?: (image: T) => string;
	renderCaption?: (image: T) => ReactNode;
	renderActions?: (image: T) => ReactNode;
	/** Keep a consuming gallery's existing skin and integration selectors. */
	classNames?: Partial<Record<"grid" | "card" | "select" | "caption", string>>;
}) {
	const [failed, setFailed] = useState<Record<string, string>>({});
	// Reaches the furthest selected image so it is never hidden behind "load more".
	const selectedEnd = selectedId
		? images.findIndex((image) => image.id === selectedId) + 1
		: 0;
	const firstPage = Math.max(1, Math.ceil(selectedEnd / pageSize)) * pageSize;
	const [paging, setPaging] = useState({
		total: images.length,
		count: firstPage,
	});
	// A list of another length starts over from its own first page.
	const visibleCount =
		paging.total === images.length
			? Math.max(paging.count, firstPage)
			: firstPage;
	const total = images.length;
	const showMore = useCallback(
		() => setPaging({ total, count: visibleCount + pageSize }),
		[total, visibleCount],
	);
	const moreRef = useRef<HTMLButtonElement>(null);
	const hasMore = visibleCount < images.length;
	useEffect(() => {
		const target = moreRef.current;
		if (!target || !hasMore || typeof IntersectionObserver === "undefined")
			return;
		let active = true;
		const observer = new IntersectionObserver((entries) => {
			if (active && entries.some((entry) => entry.isIntersecting)) {
				active = false;
				observer.disconnect();
				showMore();
			}
		});
		observer.observe(target);
		return () => {
			active = false;
			observer.disconnect();
		};
	}, [hasMore, showMore]);
	return (
		<>
			<div className={cn("image-grid", classNames?.grid)}>
				{images.slice(0, visibleCount).map((image) => (
					<article
						className={cn("image-grid-card", classNames?.card)}
						key={image.id}
						data-mode={mode}
						data-selected={mode === "select" && image.id === selectedId}
						title={
							image.disabledReason
								? `${image.title}：${image.disabledReason}`
								: image.title
						}
					>
						<div className="image-grid-media">
							<button
								type="button"
								className={cn("image-grid-select", classNames?.select)}
								disabled={
									disabled ||
									(!onPreview && !!image.disabledReason) ||
									(!!image.thumbnailUrl &&
										failed[image.id] === image.thumbnailUrl)
								}
								aria-label={
									onPreview ? `${image.title}を拡大` : selectLabel(image)
								}
								aria-pressed={
									mode === "select" && !onPreview
										? image.id === selectedId
										: undefined
								}
								onClick={() =>
									onPreview ? onPreview(image.id) : onSelect(image.id)
								}
							>
								{image.thumbnailUrl &&
								failed[image.id] !== image.thumbnailUrl ? (
									<img
										src={image.thumbnailUrl}
										alt={image.title}
										loading="lazy"
										onError={() =>
											setFailed((previous) => ({
												...previous,
												[image.id]: image.thumbnailUrl!,
											}))
										}
									/>
								) : (
									<span className="image-grid-placeholder">
										{image.thumbnailUrl
											? "画像を読み込めませんでした"
											: "画像なし"}
									</span>
								)}
							</button>
							{mode === "select" && onPreview && (
								<button
									type="button"
									className="image-grid-check"
									data-selected={image.id === selectedId}
									aria-label={selectLabel(image)}
									aria-pressed={image.id === selectedId}
									disabled={
										disabled ||
										!!image.disabledReason ||
										(!!image.thumbnailUrl &&
											failed[image.id] === image.thumbnailUrl)
									}
									onClick={() => onSelect(image.id)}
								>
									{image.id === selectedId ? "✓" : ""}
								</button>
							)}
							{mode === "select" && !onPreview && (
								<span
									className="image-grid-check"
									data-selected={image.id === selectedId}
									aria-hidden="true"
								>
									{image.id === selectedId ? "✓" : ""}
								</span>
							)}
						</div>
						<div className={cn("image-grid-caption", classNames?.caption)}>
							<div>
								{renderCaption ? (
									renderCaption(image)
								) : (
									<h4 title={image.title}>{image.title}</h4>
								)}
								{image.disabledReason && (
									<p title={image.disabledReason}>{image.disabledReason}</p>
								)}
							</div>
						</div>
						{renderActions && (
							<div className="image-grid-actions image-gallery-actions">
								{renderActions(image)}
							</div>
						)}
					</article>
				))}
			</div>
			{hasMore && (
				<button
					ref={moreRef}
					type="button"
					className="image-grid-more"
					onClick={showMore}
				>
					画像をさらに表示
				</button>
			)}
		</>
	);
}
