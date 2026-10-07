import { Button } from "../Button";

export interface OptionButtonItem<T extends string> {
	value: T;
	label: string;
	description?: string;
}

export interface OptionButtonGroupBaseProps<T extends string> {
	options: OptionButtonItem<T>[];
	columns?: 1 | 2 | 3 | 4;
	className?: string;
}

export interface SingleOptionButtonGroupProps<T extends string>
	extends OptionButtonGroupBaseProps<T> {
	multiple?: false;
	value: T | null;
	onChange: (value: T | null) => void;
	allowNull?: boolean;
	nullLabel?: string;
}

export interface MultiOptionButtonGroupProps<T extends string>
	extends OptionButtonGroupBaseProps<T> {
	multiple: true;
	value: T[];
	onChange: (value: T[]) => void;
	allowNull?: never;
	nullLabel?: never;
}

export type OptionButtonGroupProps<T extends string> =
	| SingleOptionButtonGroupProps<T>
	| MultiOptionButtonGroupProps<T>;

export function OptionButtonGroup<T extends string>(
	props: OptionButtonGroupProps<T>,
) {
	const { options, columns = 2, className = "" } = props;

	const gridColsClass = {
		1: "grid-cols-1",
		2: "grid-cols-2",
		3: "grid-cols-3",
		4: "grid-cols-4",
	}[columns];

	const handleSingleChange = (val: T | null) => {
		if (props.multiple) return;
		props.onChange(val);
	};

	const handleMultiChange = (val: T) => {
		if (!props.multiple) return;
		const currentValues = props.value;
		const newValues = currentValues.includes(val)
			? currentValues.filter((v) => v !== val)
			: [...currentValues, val];
		props.onChange(newValues);
	};

	return (
		<div className={`grid ${gridColsClass} gap-2 ${className}`}>
			{!props.multiple && props.allowNull && (
				<Button
					type="button"
					variant={props.value === null ? "option-active" : "option"}
					onClick={() => handleSingleChange(null)}
					className="justify-start min-h-[44px] text-left"
				>
					<div className="font-medium text-foreground">
						{props.nullLabel || "自動"}
					</div>
				</Button>
			)}
			{options.map((option) => {
				const isSelected = props.multiple
					? props.value.includes(option.value)
					: props.value === option.value;

				return (
					<Button
						key={option.value}
						type="button"
						variant={isSelected ? "option-active" : "option"}
						onClick={() =>
							props.multiple
								? handleMultiChange(option.value)
								: handleSingleChange(option.value)
						}
						className="justify-start min-h-[44px] text-left"
					>
						{option.description ? (
							<div>
								<div className="font-medium text-foreground">
									{option.label}
								</div>
								<div className="text-xs text-muted-foreground mt-1">
									{option.description}
								</div>
							</div>
						) : (
							<div className="font-medium text-foreground">{option.label}</div>
						)}
					</Button>
				);
			})}
		</div>
	);
}
