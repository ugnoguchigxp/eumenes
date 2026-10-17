import { Star } from "lucide-react";
import { cn } from "../../utils/cn";
import { ContentImage, type ContentImageSource } from "../ContentImage";
import "./ProductCard.css";

export type ProductBadge = "new" | "sale" | "limited" | "soldout";

const badgeLabels: Record<ProductBadge, string> = {
	new: "新着",
	sale: "セール",
	limited: "限定",
	soldout: "売り切れ",
};

export type ProductCardProps = {
	image?: ContentImageSource;
	name: string;
	/** Display string such as "¥3,800". */
	price?: string;
	/** Struck-through regular price. */
	compareAtPrice?: string;
	badge?: ProductBadge;
	body?: string;
	/** 0 to 5 in steps of 0.5. */
	rating?: number;
	variant?: "vertical" | "horizontal";
	className?: string;
};

function normalizeRating(rating: number | undefined): number | undefined {
	if (rating === undefined || !Number.isFinite(rating)) return undefined;
	return Math.round(Math.min(5, Math.max(0, rating)) * 2) / 2;
}

function Rating({ value }: { value: number }) {
	return (
		<div className="ds-product-card-rating">
			<span className="ds-product-card-stars" aria-hidden="true">
				{[0, 1, 2, 3, 4].map((index) => {
					const fill = Math.min(1, Math.max(0, value - index));
					return (
						<span className="ds-product-card-star" key={index}>
							<Star size={16} />
							{fill > 0 && (
								<span
									className="ds-product-card-star-fill"
									style={{ width: `${fill * 100}%` }}
								>
									<Star size={16} fill="currentColor" />
								</span>
							)}
						</span>
					);
				})}
			</span>
			<span className="ds-product-card-sr">{`5点満点中${value}点`}</span>
		</div>
	);
}

export function ProductCard({
	image,
	name,
	price,
	compareAtPrice,
	badge,
	body,
	rating,
	variant = "vertical",
	className,
}: ProductCardProps) {
	const value = normalizeRating(rating);
	return (
		<article
			className={cn("ds-product-card", className)}
			data-variant={variant}
			data-soldout={badge === "soldout"}
		>
			<div className="ds-product-card-inner">
				{(image || badge) && (
					<div className="ds-product-card-media">
						<ContentImage
							image={image ?? { placeholder: "neutral" }}
							aspect="square"
							rounded={false}
						/>
						{badge && (
							<span className="ds-product-card-badge" data-badge={badge}>
								{badgeLabels[badge]}
							</span>
						)}
					</div>
				)}
				<div className="ds-product-card-text">
					<h3>{name}</h3>
					{value !== undefined && <Rating value={value} />}
					{(price || compareAtPrice) && (
						<p className="ds-product-card-prices">
							{price && (
								<span className="ds-product-card-price">
									<span className="ds-product-card-sr">販売価格 </span>
									{price}
								</span>
							)}
							{compareAtPrice && (
								<s className="ds-product-card-compare">
									<span className="ds-product-card-sr">通常価格 </span>
									{compareAtPrice}
								</s>
							)}
						</p>
					)}
					{body && <p className="ds-product-card-body">{body}</p>}
				</div>
			</div>
		</article>
	);
}
