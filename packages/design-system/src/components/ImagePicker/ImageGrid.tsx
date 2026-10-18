import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "../../utils/cn";
import "./ImagePicker.css";

export type ImageGridItem = {
	id: string;
	title: string;
	thumbnailUrl?: string;
	disabledReason?: string;
};

/** Presentation only: selection, preview and management are separate host actions. */
export function ImageGrid<T extends ImageGridItem>({
	images,
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
	return (
		<div className={cn("image-grid", classNames?.grid)}>
			{images.map((image) => (
				<article
					className={cn("image-grid-card", classNames?.card)}
					key={image.id}
					data-selected={image.id === selectedId}
				>
					<div className="image-grid-media">
						<button
							type="button"
							className={cn("image-grid-select", classNames?.select)}
							disabled={
								disabled ||
								!!image.disabledReason ||
								(!!image.thumbnailUrl &&
									failed[image.id] === image.thumbnailUrl)
							}
							aria-label={selectLabel(image)}
							aria-pressed={image.id === selectedId}
							onClick={() => onSelect(image.id)}
						>
							{image.thumbnailUrl && failed[image.id] !== image.thumbnailUrl ? (
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
						{image.id === selectedId && (
							<span className="image-grid-check" aria-hidden="true">
								✓
							</span>
						)}
						{onPreview &&
							image.thumbnailUrl &&
							failed[image.id] !== image.thumbnailUrl && (
								<button
									type="button"
									className="image-grid-preview"
									aria-label={`${image.title}を拡大`}
									disabled={disabled}
									onClick={() => onPreview(image.id)}
								>
									拡大
								</button>
							)}
					</div>
					<div className={cn("image-grid-caption", classNames?.caption)}>
						<div>
							{renderCaption ? renderCaption(image) : <h4>{image.title}</h4>}
							{image.disabledReason && <p>{image.disabledReason}</p>}
						</div>
						{renderActions && (
							<div className="image-gallery-actions">
								{renderActions(image)}
							</div>
						)}
					</div>
				</article>
			))}
		</div>
	);
}
