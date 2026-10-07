import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as React from "react";
import { PercentFormat } from "@/components/NumberFormat";
import { cn } from "@/utils/cn";

export interface ProgressBarProps
	extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
	value: number;
	label?: React.ReactNode;
	subLabel?: React.ReactNode;
	height?: string;
	color?: string;
	striped?: boolean;
	animated?: boolean;
	status?: "normal" | "paused" | "error";
}

const ProgressBar = React.forwardRef<
	React.ElementRef<typeof ProgressPrimitive.Root>,
	ProgressBarProps
>(
	(
		{
			className,
			value,
			label,
			subLabel,
			height = "h-[var(--ui-progress-height)]",
			color,
			striped = true,
			animated = true,
			status = "normal",
			...props
		},
		ref,
	) => {
		const percentage = Math.min(Math.max(value || 0, 0), 100);

		const interpolateColor = (
			start: number[],
			end: number[],
			factor: number,
		) => {
			const result = start.map((startVal, i) => {
				const endVal = end[i] || 0;
				return Math.round(startVal + (endVal - startVal) * factor);
			});
			return `rgb(${result.join(",")})`;
		};

		const getProgressStyle = () => {
			if (color) return { className: color };

			if (status === "paused") return { className: "bg-yellow-500" };
			if (status === "error") return { className: "bg-red-800" };

			// Normal status: Smooth interpolation
			// 0% (Dark Green: #047857 [4, 120, 87]) -> 50% (Blue: #2563EB [37, 99, 235]) -> 100% (Light Blue: #22D3EE [34, 211, 238])
			const darkGreen = [4, 120, 87];
			const blue = [37, 99, 235];
			const lightBlue = [34, 211, 238];

			let backgroundColor = "";
			if (percentage <= 50) {
				backgroundColor = interpolateColor(darkGreen, blue, percentage / 50);
			} else {
				backgroundColor = interpolateColor(
					blue,
					lightBlue,
					(percentage - 50) / 50,
				);
			}

			return { style: { backgroundColor } };
		};

		const { className: colorClass, style: colorStyle } = getProgressStyle();

		return (
			<div className="w-full">
				{(label || subLabel) && (
					<div className="flex justify-between mb-1 text-sm">
						<div className="font-medium text-foreground">{label}</div>
						<div className="text-muted-foreground">{subLabel}</div>
					</div>
				)}
				<ProgressPrimitive.Root
					ref={ref}
					className={cn(
						"relative w-full overflow-hidden rounded-full bg-card",
						height,
						className,
					)}
					value={value}
					{...props}
				>
					<ProgressPrimitive.Indicator
						className={cn(
							"h-full w-full flex-1 transition-all duration-500 ease-out flex items-center justify-end pr-2",
							colorClass,
							striped &&
								"bg-[linear-gradient(45deg,rgba(255,255,255,0.15)_25%,transparent_25%,transparent_50%,rgba(255,255,255,0.15)_50%,rgba(255,255,255,0.15)_75%,transparent_75%,transparent)] bg-[length:1rem_1rem]",
							animated && "animate-progress-stripes",
						)}
						style={{
							transform: `translateX(-${100 - percentage}%)`,
							...colorStyle,
						}}
					>
						{/* Optional: Show percentage inside bar if tall enough */}
						{height !== "h-1" && height !== "h-2" && (
							<PercentFormat
								value={percentage}
								valueScale="percent"
								options={{ maximumFractionDigits: 0 }}
								className="text-[10px] font-bold text-white drop-shadow-md opacity-80 pe-1"
							/>
						)}
					</ProgressPrimitive.Indicator>
				</ProgressPrimitive.Root>
			</div>
		);
	},
);
ProgressBar.displayName = ProgressPrimitive.Root.displayName;

export { ProgressBar };
