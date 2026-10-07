import * as React from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/utils/cn";

interface ISkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
	showSpinner?: boolean;
	spinnerSize?: "xs" | "sm" | "md" | "lg" | "xl";
	spinnerVariant?: "primary" | "secondary" | "accent";
}

const Skeleton = React.memo<ISkeletonProps>(
	({
		className,
		showSpinner = false,
		spinnerSize = "md",
		spinnerVariant = "primary",
		...props
	}) => {
		return (
			<div
				className={cn(
					"animate-pulse rounded-md bg-card opacity-50",
					showSpinner && "relative flex items-center justify-center",
					className,
				)}
				{...props}
			>
				{showSpinner && (
					<div className="absolute inset-0 flex items-center justify-center">
						<Spinner size={spinnerSize} variant={spinnerVariant} />
					</div>
				)}
			</div>
		);
	},
);

Skeleton.displayName = "Skeleton";

export { Skeleton };
