import { cn } from "../../utils/cn";
import {
	ContentImage,
	type ContentImageAspect,
	type ContentImageSource,
} from "../ContentImage";
import "./MediaCard.css";

export type MediaCardProps = {
	image: ContentImageSource;
	aspect?: ContentImageAspect;
	eyebrow?: string;
	title: string;
	body?: string;
	variant?: "vertical" | "horizontal";
	className?: string;
};

export function MediaCard({
	image,
	aspect = "landscape",
	eyebrow,
	title,
	body,
	variant = "vertical",
	className,
}: MediaCardProps) {
	return (
		<article className={cn("ds-media-card", className)} data-variant={variant}>
			<div className="ds-media-card-inner">
				<ContentImage
					className="ds-media-card-image"
					image={image}
					aspect={aspect}
					rounded={false}
				/>
				<div className="ds-media-card-text">
					{eyebrow && <p className="ds-media-card-eyebrow">{eyebrow}</p>}
					<h3>{title}</h3>
					{body && <p className="ds-media-card-body">{body}</p>}
				</div>
			</div>
		</article>
	);
}
