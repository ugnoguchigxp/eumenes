import type React from "react";

interface Option {
	label: string;
	value: string;
}

interface SelectableTextInputProps {
	options: Option[];
	value?: string;
	onChange?: (value: string) => void;
	placeholder?: string;
	className?: string;
}

export const SelectableTextInput: React.FC<SelectableTextInputProps> = ({
	options,
	value,
	onChange,
	placeholder,
	className,
}) => {
	return (
		<div className={className}>
			<select
				className="mb-1 w-full rounded border border-border bg-background px-3 py-2 text-sm h-10 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
				value={value}
				onChange={(e) => onChange?.(e.target.value)}
			>
				{options.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
			<input
				type="text"
				className="w-full rounded border border-border bg-background px-3 py-2 text-sm h-10 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
				placeholder={placeholder}
			/>
		</div>
	);
};

export default SelectableTextInput;
