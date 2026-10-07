import type { ComponentType } from "react";
import React from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/Tooltip/Tooltip";
/**
 * ViewSwitcher Component
 * ビュー切り替えスイッチ
 */
import { cn } from "@/utils/cn";

interface ViewOption {
	value: string;
	icon: ComponentType<{ className?: string }>;
	tooltip: string;
}

interface ViewSwitcherProps {
	options: ViewOption[];
	value: string;
	onChange: (value: string) => void;
	className?: string;
}

export const ViewSwitcher = React.memo(
	({ options, value, onChange, className }: ViewSwitcherProps) => {
		return (
			<TooltipProvider>
				<div
					className={cn(
						"inline-flex rounded-lg border border-border bg-background p-1",
						className,
					)}
				>
					{options.map((option) => {
						const Icon = option.icon;
						const isActive = value === option.value;

						return (
							<Tooltip key={option.value}>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={() => onChange(option.value)}
										className={cn(
											"flex items-center justify-center p-2 rounded transition-colors",
											isActive
												? "bg-accent text-white"
												: "text-muted-foreground hover:bg-card hover:text-foreground",
										)}
										aria-label={option.tooltip}
									>
										<Icon className="text-lg" />
									</button>
								</TooltipTrigger>
								<TooltipContent>
									<p>{option.tooltip}</p>
								</TooltipContent>
							</Tooltip>
						);
					})}
				</div>
			</TooltipProvider>
		);
	},
);
