import { useState } from "react";
import { cn } from "../../utils/cn";
import "./ContentImage.css";

export type ContentImageSource =
	| { src: string; srcSet?: string; alt: string }
	| { placeholder: "accent" | "neutral" | "warm" | "cool"; alt?: string };

export type ContentImageAspect = "landscape" | "square" | "portrait" | "wide";

export type ContentImageProps = {
	image: ContentImageSource;
	/** landscape 16:9 / square 1:1 / portrait 3:4 / wide 21:9. */
	aspect?: ContentImageAspect;
	caption?: string;
	rounded?: boolean;
	/** Fill the parent box instead of fixing an aspect ratio (backgrounds). */
	fill?: boolean;
	/** Called once when the real image failed to load. */
	onImageError?: () => void;
	className?: string;
};

/**
 * A fixed-frame image. A failed or missing image is drawn as a gradient of the
 * same frame; nothing is requested from the network for the placeholder.
 */
export function ContentImage({
	image,
	aspect = "landscape",
	caption,
	rounded = true,
	fill = false,
	onImageError,
	className,
}: ContentImageProps) {
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const real = "src" in image ? image : null;
	const failed = real !== null && failedSrc === real.src;
	const tone = real ? "accent" : (image as { placeholder: string }).placeholder;
	const alt = image.alt ?? "";
	const showPlaceholder = real === null || failed;
	const frame = (
		<div
			className="ds-content-image-frame"
			data-aspect={fill ? "fill" : aspect}
			data-rounded={rounded}
			data-placeholder={showPlaceholder ? tone : undefined}
			{...(showPlaceholder
				? alt
					? { role: "img", "aria-label": alt }
					: { "aria-hidden": true }
				: {})}
		>
			{real && !failed && (
				<img
					src={real.src}
					srcSet={real.srcSet}
					alt={real.alt}
					referrerPolicy="no-referrer"
					loading="lazy"
					decoding="async"
					onError={() => {
						setFailedSrc(real.src);
						onImageError?.();
					}}
				/>
			)}
		</div>
	);
	if (!caption) {
		return (
			<div className={cn("ds-content-image", className)} data-fill={fill}>
				{frame}
			</div>
		);
	}
	return (
		<figure className={cn("ds-content-image", className)} data-fill={fill}>
			{frame}
			<figcaption>{caption}</figcaption>
		</figure>
	);
}
