import * as React from "react";
import { cn } from "@/utils/cn";

interface ISpinnerProps extends React.HTMLAttributes<HTMLOutputElement> {
	size?: "xs" | "sm" | "md" | "lg" | "xl";
	variant?: "primary" | "secondary" | "accent";
}

const sizeClasses = {
	xs: "h-4 w-4 border-2",
	sm: "h-6 w-6 border-2",
	md: "h-8 w-8 border-[3px]",
	lg: "h-12 w-12 border-[3px]",
	xl: "h-16 w-16 border-4",
};

const variantClasses = {
	primary: "border-theme-object-primary border-t-transparent",
	secondary: "border-theme-text-secondary border-t-transparent",
	accent: "border-theme-accent border-t-transparent",
};

export const Spinner = React.memo<ISpinnerProps>(
	({ size = "md", variant = "primary", className, ...props }) => {
		const t = (key: string, fallback?: string) => fallback ?? key;
		return (
			<output
				aria-live="polite"
				aria-label="Loading"
				className={cn("inline-block", className)}
				{...props}
			>
				<div
					className={cn(
						"animate-spin rounded-full",
						sizeClasses[size],
						variantClasses[variant],
					)}
				/>
				<span className="sr-only">{t("loading")}</span>
			</output>
		);
	},
);

Spinner.displayName = "Spinner";
