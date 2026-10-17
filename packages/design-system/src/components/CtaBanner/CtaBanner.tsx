import { cn } from "../../utils/cn";
import { ContentImage, type ContentImageSource } from "../ContentImage";
import "./CtaBanner.css";

export type CtaBannerProps = {
	title: string;
	body?: string;
	/** Display only. The labels do not navigate or submit anything. */
	primaryLabel?: string;
	secondaryLabel?: string;
	/** Used as the backdrop of variant "image". */
	image?: ContentImageSource;
	variant?: "accent" | "subtle" | "image";
	className?: string;
};

export function CtaBanner({
	title,
	body,
	primaryLabel,
	secondaryLabel,
	image,
	variant = "accent",
	className,
}: CtaBannerProps) {
	const backdrop = variant === "image";
	return (
		<section className={cn("ds-cta-banner", className)} data-variant={variant}>
			{backdrop && (
				<>
					<ContentImage
						className="ds-cta-banner-backdrop"
						image={image ?? { placeholder: "accent" }}
						rounded={false}
						fill
					/>
					<div className="ds-cta-banner-overlay" aria-hidden="true" />
				</>
			)}
			<div className="ds-cta-banner-inner">
				<div className="ds-cta-banner-text">
					<h2>{title}</h2>
					{body && <p>{body}</p>}
				</div>
				{(primaryLabel || secondaryLabel) && (
					<div className="ds-cta-banner-actions">
						{primaryLabel && (
							<span className="ds-cta-banner-button" data-kind="primary">
								{primaryLabel}
							</span>
						)}
						{secondaryLabel && (
							<span className="ds-cta-banner-button" data-kind="secondary">
								{secondaryLabel}
							</span>
						)}
					</div>
				)}
			</div>
		</section>
	);
}
