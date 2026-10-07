import { ChevronLeft, ChevronRight } from "lucide-react";
import React, { type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { Button } from "../Button";

export interface PaginationProps {
	currentPage: number;
	totalPages: number;
	onPrevPage: () => void;
	onNextPage: () => void;
	prevLabel?: string;
	nextLabel?: string;
	prevContent?: ReactNode;
	nextContent?: ReactNode;
	pageInfoFormatter?: (currentPage: number, totalPages: number) => ReactNode;
	className?: string;
}

export const Pagination = React.memo(
	({
		currentPage,
		totalPages,
		onPrevPage,
		onNextPage,
		prevLabel = "Previous page",
		nextLabel = "Next page",
		prevContent = <ChevronLeft className="h-4 w-4" />,
		nextContent = <ChevronRight className="h-4 w-4" />,
		pageInfoFormatter,
		className,
	}: PaginationProps) => {
		if (totalPages <= 1) {
			return null;
		}

		const prevDisabled = currentPage <= 1;
		const nextDisabled = currentPage >= totalPages;

		const pageInfo =
			pageInfoFormatter?.(currentPage, totalPages) ??
			`${currentPage} / ${totalPages}`;

		const handlePrev = () => {
			if (!prevDisabled) {
				onPrevPage();
			}
		};

		const handleNext = () => {
			if (!nextDisabled) {
				onNextPage();
			}
		};

		return (
			<div className={cn("flex flex-wrap items-center gap-2", className)}>
				<Button
					type="button"
					variant="outline"
					size="icon"
					onClick={handlePrev}
					disabled={prevDisabled}
					aria-label={prevLabel}
				>
					{prevContent}
				</Button>

				<span
					className="text-ui text-foreground font-medium whitespace-nowrap"
					aria-live="polite"
				>
					{pageInfo}
				</span>

				<Button
					type="button"
					variant="outline"
					size="icon"
					onClick={handleNext}
					disabled={nextDisabled}
					aria-label={nextLabel}
				>
					{nextContent}
				</Button>
			</div>
		);
	},
);
