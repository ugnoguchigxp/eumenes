import * as React from "react";
import { cn } from "@/utils/cn";

export interface IScaleInputProps {
	/** Label for the input */
	label?: string;
	/** Current selected value */
	value?: number;
	/** Callback when value changes */
	onChange: (value: number) => void;
	/** Minimum value (default: 0) */
	min?: number;
	/** Maximum value (default: 10) */
	max?: number;
	/** Label for the minimum value (e.g. "No Pain") */
	minLabel?: string;
	/** Label for the maximum value (e.g. "Worst Pain") */
	maxLabel?: string;
	/** Additional class name */
	className?: string;
	/** Disabled state */
	disabled?: boolean;
}

export const ScaleInput = React.memo(
	({
		label,
		value,
		onChange,
		min = 0,
		max = 10,
		minLabel,
		maxLabel,
		className,
		disabled = false,
	}: IScaleInputProps) => {
		// Generate range of numbers
		const range = React.useMemo(() => {
			const arr = [];
			for (let i = min; i <= max; i++) {
				arr.push(i);
			}
			return arr;
		}, [min, max]);

		return (
			<div className={cn("flex flex-col gap-2", className)}>
				{label && (
					<span className="text-sm font-medium text-muted-foreground">
						{label}
					</span>
				)}
				<div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-theme-border scrollbar-track-transparent">
					{range.map((num) => (
						<button
							key={num}
							onClick={() => !disabled && onChange(num)}
							disabled={disabled}
							type="button"
							className={cn(
								"w-[var(--ui-component-height)] h-[var(--ui-component-height)] rounded-full flex-shrink-0 flex items-center justify-center font-bold transition-all border",
								value === num
									? "bg-primary text-primary-foreground border-theme-object-primary shadow-md scale-110"
									: "bg-card text-muted-foreground border-border hover:bg-muted",
								disabled &&
									"opacity-50 cursor-not-allowed hover:bg-card hover:scale-100",
							)}
						>
							{num}
						</button>
					))}
				</div>
				{(minLabel || maxLabel) && (
					<div className="flex justify-between text-xs text-muted-foreground px-1 select-none">
						<span>{minLabel}</span>
						<span>{maxLabel}</span>
					</div>
				)}
			</div>
		);
	},
);

ScaleInput.displayName = "ScaleInput";
