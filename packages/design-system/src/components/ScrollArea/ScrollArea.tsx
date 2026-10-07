import * as React from "react";
import { cn } from "@/utils/cn";

interface IScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
	children: React.ReactNode;
}

export const ScrollArea = React.memo(
	React.forwardRef<HTMLDivElement, IScrollAreaProps>(
		({ className, children, ...props }, ref) => {
			return (
				<div
					ref={ref}
					className={cn("relative overflow-auto", className)}
					{...props}
				>
					{children}
				</div>
			);
		},
	),
);

ScrollArea.displayName = "ScrollArea";
