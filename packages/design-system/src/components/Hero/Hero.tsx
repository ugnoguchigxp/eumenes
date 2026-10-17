import { cn } from "../../utils/cn";
import { ContentImage, type ContentImageSource } from "../ContentImage";
import "./Hero.css";

export type HeroProps = {
	eyebrow?: string;
	title: string;
	body?: string;
	/** Display only. The labels do not navigate or submit anything. */
	primaryLabel?: string;
	secondaryLabel?: string;
	image?: ContentImageSource;
	variant?: "centered" | "split" | "background";
	/** Only for variant "background": the tint laid over the image. */
	overlay?: "dark" | "light" | "accent";
	align?: "start" | "center";
	height?: "md" | "lg";
	className?: string;
};

export function Hero({
	eyebrow,
	title,
	body,
	primaryLabel,
	secondaryLabel,
	image,
	variant = "centered",
	overlay = "dark",
	align = "center",
	height = "md",
	className,
}: HeroProps) {
	const background = variant === "background";
	const text = (
		<div className="ds-hero-text">
			{eyebrow && <p className="ds-hero-eyebrow">{eyebrow}</p>}
			<h2>{title}</h2>
			{body && <p className="ds-hero-body">{body}</p>}
			{(primaryLabel || secondaryLabel) && (
				<div className="ds-hero-actions">
					{primaryLabel && (
						<span className="ds-hero-button" data-kind="primary">
							{primaryLabel}
						</span>
					)}
					{secondaryLabel && (
						<span className="ds-hero-button" data-kind="secondary">
							{secondaryLabel}
						</span>
					)}
				</div>
			)}
		</div>
	);
	return (
		<section
			className={cn("ds-hero", className)}
			data-variant={variant}
			data-overlay={background ? overlay : undefined}
			data-align={background ? align : undefined}
			data-height={background ? height : undefined}
		>
			{background ? (
				<>
					<ContentImage
						className="ds-hero-backdrop"
						image={image ?? { placeholder: "accent" }}
						rounded={false}
						fill
					/>
					<div className="ds-hero-overlay" aria-hidden="true" />
					<div className="ds-hero-inner">{text}</div>
				</>
			) : (
				<div className="ds-hero-inner">
					{text}
					{image && (
						<ContentImage
							className="ds-hero-image"
							image={image}
							aspect="landscape"
						/>
					)}
				</div>
			)}
		</section>
	);
}
