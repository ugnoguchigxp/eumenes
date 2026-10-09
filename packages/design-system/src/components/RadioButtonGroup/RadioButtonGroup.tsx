import { useId } from "react";
import { cn } from "@/utils/cn";
import "./RadioButtonGroup.css";

export interface RadioButtonGroupProps {
	label: string;
	options: readonly { value: string; label: string; disabled?: boolean }[];
	value: string;
	onValueChange: (value: string) => void;
	name?: string;
	disabled?: boolean;
	required?: boolean;
	className?: string;
}

/** Native radio semantics with a full-row selection target. */
export function RadioButtonGroup({
	label,
	options,
	value,
	onValueChange,
	name,
	disabled = false,
	required = false,
	className,
}: RadioButtonGroupProps) {
	const id = useId();
	return (
		<fieldset className={cn("ds-radio-group", className)} disabled={disabled}>
			<legend className="ds-radio-legend">{label}</legend>
			<div className="ds-radio-options">
				{options.map((option, index) => (
					<label className="ds-radio-option" key={option.value}>
						<input
							className="ds-radio-input"
							id={`${id}-${index}`}
							type="radio"
							name={name ?? id}
							value={option.value}
							checked={value === option.value}
							onChange={(event) => onValueChange(event.target.value)}
							disabled={disabled || option.disabled}
							required={required}
						/>
						<span className="ds-radio-label">{option.label}</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}
