import { Search } from "lucide-react";
import React from "react";
import { cn } from "@/utils/cn";

export interface SimpleSearchInputProps
	extends React.InputHTMLAttributes<HTMLInputElement> {
	onSearch?: (query: string) => void;
}

export const SimpleSearchInput = React.memo(
	React.forwardRef<HTMLInputElement, SimpleSearchInputProps>(
		({ onSearch, className, ...props }, ref) => {
			return (
				<div className="relative w-full">
					<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<input
						ref={ref}
						type="text"
						className={cn(
							"flex h-11 w-full rounded-md border border-input bg-background pl-10 pr-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
							className,
						)}
						placeholder="Search..."
						onChange={(e) => onSearch?.(e.target.value)}
						{...props}
					/>
				</div>
			);
		},
	),
);

SimpleSearchInput.displayName = "SimpleSearchInput";
