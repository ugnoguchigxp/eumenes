import { type CSSProperties, useId } from "react";
import { cn } from "../../utils/cn";
import "./RangeSlider.css";

export type RangeSliderProps = {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	onChange: (value: number) => void;
	/** 表示用の文字列へ変える（単位・桁区切りなど）。 */
	formatValue?: (value: number) => string;
	disabled?: boolean;
	className?: string;
};

export function RangeSlider({
	label,
	value,
	min,
	max,
	step = 1,
	onChange,
	formatValue,
	disabled = false,
	className,
}: RangeSliderProps) {
	const id = useId();
	const text = formatValue ? formatValue(value) : String(value);
	const span = max - min;
	const percent =
		span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
	return (
		<div className={cn("ds-range-slider", className)}>
			<div className="ds-range-slider-head">
				<label htmlFor={id}>{label}</label>
				<output htmlFor={id} className="ds-range-slider-value">
					{text}
				</output>
			</div>
			<input
				id={id}
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				aria-valuetext={text}
				style={{ "--ds-range-percent": `${percent}%` } as CSSProperties}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
		</div>
	);
}
