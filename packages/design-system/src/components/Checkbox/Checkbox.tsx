/**
 * Checkbox Component
 * チェックボックスコンポーネント
 */

import { CheckCircle, Circle } from "lucide-react";
import * as React from "react";
import { cn } from "@/utils/cn";
import { cardVariants } from "../Card/Card";

export interface ICheckboxProps {
	id?: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	className?: string;
	disabled?: boolean;
	variant?: "default" | "card";
}

export const Checkbox = React.memo(
	React.forwardRef<HTMLInputElement, ICheckboxProps>(
		(
			{
				id,
				checked,
				onChange,
				label,
				className,
				disabled = false,
				variant = "default",
			},
			ref,
		) => {
			const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
				onChange(e.target.checked);
			};

			if (variant === "card") {
				return (
					<label
						className={cn(
							cardVariants({ variant: "default" }),
							"w-full flex items-center gap-3 p-[var(--ui-component-padding-x)] transition-all min-h-[var(--ui-component-height)] cursor-pointer",
							checked ? "border-theme-success/50" : "hover:bg-muted",
							disabled && "opacity-50 cursor-not-allowed",
							className,
						)}
					>
						<input
							ref={ref}
							id={id}
							type="checkbox"
							checked={checked}
							onChange={handleChange}
							disabled={disabled}
							className="sr-only"
						/>
						<div
							className={cn(
								"text-[length:calc(var(--ui-checkbox-size)*1.5)] flex-shrink-0 transition-colors",
								checked ? "text-success" : "text-theme-border",
							)}
						>
							{checked ? <CheckCircle size="1em" /> : <Circle size="1em" />}
						</div>
						<span
							className={cn(
								"text-ui font-medium",
								checked ? "text-foreground" : "text-muted-foreground",
							)}
						>
							{label}
						</span>
					</label>
				);
			}

			return (
				<label
					className={cn(
						"flex items-center gap-2 min-h-[44px] cursor-pointer hover:bg-accent rounded px-2",
						disabled && "opacity-50 cursor-not-allowed",
						className,
					)}
				>
					<input
						ref={ref}
						id={id}
						type="checkbox"
						checked={checked}
						onChange={handleChange}
						disabled={disabled}
						className="w-[var(--ui-checkbox-size)] h-[var(--ui-checkbox-size)] rounded border-2 border-border text-accent-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer disabled:cursor-not-allowed"
					/>
					<span className="text-ui select-none text-foreground">{label}</span>
				</label>
			);
		},
	),
);

Checkbox.displayName = "Checkbox";
