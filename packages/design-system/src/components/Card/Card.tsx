import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/utils/cn";

const cardVariants = cva("rounded-lg border shadow-sm", {
	variants: {
		variant: {
			default: "bg-card text-card-foreground border-border",
			destructive:
				"border-destructive/50 bg-destructive/10 text-destructive-foreground border-2",
			warning:
				"border-warning/50 bg-warning/10 text-warning-foreground border-2",
		},
	},
	defaultVariants: {
		variant: "default",
	},
});

export interface CardProps
	extends React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof cardVariants> {}

const Card = React.memo(
	React.forwardRef<HTMLDivElement, CardProps>(
		({ className, variant, ...props }, ref) => (
			<div
				ref={ref}
				className={cn(cardVariants({ variant }), className)}
				{...props}
			/>
		),
	),
);
Card.displayName = "Card";

const CardHeader = React.memo(
	React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
		({ className, ...props }, ref) => (
			<div
				ref={ref}
				className={cn(
					"flex flex-col space-y-1.5 p-[var(--ui-card-padding)]",
					className,
				)}
				{...props}
			/>
		),
	),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.memo(
	React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
		({ className, ...props }, ref) => (
			<div
				ref={ref}
				className={cn(
					"text-2xl font-semibold leading-none tracking-tight text-foreground",
					className,
				)}
				{...props}
			/>
		),
	),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.memo(
	React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
		({ className, ...props }, ref) => (
			<div
				ref={ref}
				className={cn("text-sm text-muted-foreground", className)}
				{...props}
			/>
		),
	),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.memo(
	React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
		({ className, ...props }, ref) => (
			<div
				ref={ref}
				className={cn("p-[var(--ui-card-padding)] pt-0", className)}
				{...props}
			/>
		),
	),
);
CardContent.displayName = "CardContent";

const CardFooter = React.memo(
	React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
		({ className, ...props }, ref) => (
			<div
				ref={ref}
				className={cn(
					"flex items-center p-[var(--ui-card-padding)] pt-0",
					className,
				)}
				{...props}
			/>
		),
	),
);
CardFooter.displayName = "CardFooter";

export {
	Card,
	CardHeader,
	CardFooter,
	CardTitle,
	CardDescription,
	CardContent,
	cardVariants,
};
