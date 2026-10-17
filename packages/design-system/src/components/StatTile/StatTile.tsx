import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "../../utils/cn";
import "./StatTile.css";

export type StatTrend = "up" | "down" | "flat";

export type StatTileProps = {
	label: string;
	/** 表示済みの文字列。値が無効なときは呼び出し側が「—」を渡す。 */
	value: string;
	caption?: string;
	trend?: StatTrend;
	className?: string;
};

const trends = {
	up: { Icon: TrendingUp, text: "上昇" },
	down: { Icon: TrendingDown, text: "下降" },
	flat: { Icon: Minus, text: "横ばい" },
} as const;

export function StatTile({
	label,
	value,
	caption,
	trend,
	className,
}: StatTileProps) {
	const mark = trend ? trends[trend] : undefined;
	return (
		<div className={cn("ds-stat-tile", className)} data-trend={trend}>
			<p className="ds-stat-tile-label">{label}</p>
			<p className="ds-stat-tile-value">
				<span>{value}</span>
				{mark && (
					<span className="ds-stat-tile-trend">
						<mark.Icon aria-hidden="true" />
						<span className="ds-stat-tile-sr">{mark.text}</span>
					</span>
				)}
			</p>
			{caption && <p className="ds-stat-tile-caption">{caption}</p>}
		</div>
	);
}
