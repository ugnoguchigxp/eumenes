import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/utils/cn";

const BadgeVariants = cva(
	"inline-flex items-center rounded-full border px-[var(--ui-badge-padding-x)] py-[var(--ui-badge-padding-y)] text-ui font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 whitespace-nowrap",
	{
		variants: {
			variant: {
				default:
					"border-transparent bg-accent text-accent-foreground hover:bg-accent/80",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
				destructive:
					"border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
				outline: "text-foreground border-border",
				success:
					"border-transparent bg-success text-success-foreground hover:bg-success/80",
				warning:
					"border-transparent bg-warning text-warning-foreground hover:bg-warning/80",
				// Additional variants for patient list - light backgrounds with dark text
				sky: "border-transparent bg-sky-200 text-sky-900 dark:bg-sky-900 dark:text-sky-100 hover:bg-sky-300 dark:hover:bg-sky-800",
				pink: "border-transparent bg-pink-200 text-pink-800 dark:bg-pink-900 dark:text-pink-100 hover:bg-pink-300 dark:hover:bg-pink-800",
				gray: "border-transparent bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200 hover:bg-stone-300 dark:hover:bg-stone-700",
				green:
					"border-transparent bg-teal-200 text-gray-900 dark:bg-teal-900 dark:text-teal-100 hover:bg-teal-300 dark:hover:bg-teal-800",
				yellow:
					"border-transparent bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-100 hover:bg-amber-300 dark:hover:bg-amber-800",
				red: "border-transparent bg-rose-200 text-rose-800 dark:bg-rose-900 dark:text-rose-100 hover:bg-rose-300 dark:hover:bg-rose-800",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export interface BadgeProps
	extends React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof BadgeVariants> {
	label?: React.ReactNode;
	pill?: boolean;
}

const Badge = React.memo(
	({ className, variant, label, pill, children, ...props }: BadgeProps) => {
		return (
			<div className={cn(BadgeVariants({ variant }), className)} {...props}>
				{label ?? children}
			</div>
		);
	},
);

export { Badge, BadgeVariants };
