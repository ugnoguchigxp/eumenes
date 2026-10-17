import { Check } from "lucide-react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";
import "./PricingCard.css";

export type PricingCardProps = {
	plan: string;
	/** 表示用の文字列（例: 「¥1,200」）。計算は呼び出し側で済ませる。 */
	price: string;
	period?: string;
	body?: string;
	features: string[];
	/** 表示だけのボタン。押しても何も起きない。 */
	ctaLabel?: string;
	highlighted?: boolean;
	className?: string;
};

export function PricingCard({
	plan,
	price,
	period,
	body,
	features,
	ctaLabel,
	highlighted = false,
	className,
}: PricingCardProps) {
	return (
		<section
			className={cn("ds-pricing-card", className)}
			data-highlighted={highlighted}
			aria-label={`${plan}プラン`}
		>
			{highlighted && <span className="ds-pricing-card-badge">おすすめ</span>}
			<h3 className="ds-pricing-card-plan">{plan}</h3>
			<p className="ds-pricing-card-price">
				<span className="ds-pricing-card-amount">{price}</span>
				{period && <span className="ds-pricing-card-period">/ {period}</span>}
			</p>
			{body && <p className="ds-pricing-card-body">{body}</p>}
			<ul className="ds-pricing-card-features">
				{features.map((feature, index) => (
					<li key={`${index}-${feature}`}>
						<Check className="ds-pricing-card-check" aria-hidden="true" />
						<span>{feature}</span>
					</li>
				))}
			</ul>
			{ctaLabel && (
				<Button
					type="button"
					className="ds-pricing-card-cta"
					variant={highlighted ? "default" : "outline"}
					maxLabelLength={40}
				>
					{ctaLabel}
				</Button>
			)}
		</section>
	);
}
