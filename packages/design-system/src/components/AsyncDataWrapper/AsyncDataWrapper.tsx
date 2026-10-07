import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/Skeleton";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/utils/cn";

interface AsyncDataWrapperProps {
	isLoading: boolean;
	isError: unknown;
	refetch: () => void;
	children: React.ReactNode;
	isFetching?: boolean;
	className?: string;
	isEmpty?: boolean;
	emptyMessage?: string;
	/**
	 * According to CODING_RULES:
	 * "If data is not yet arrived (initial loading), show Skeleton stack + Spinner in center."
	 * If false, it might just show spinner (e.g. for small components), but page usage implies true.
	 * Default: true
	 */
	useSkeletonLoading?: boolean;
	/** Text shown during loading state. Default: "Loading..." */
	loadingText?: string;
	/** Text shown when data is empty. Default: "No data available" */
	noDataText?: string;
	/** Text for refresh button. Default: "Refresh data" */
	refreshText?: string;
}

export const AsyncDataWrapper = ({
	isLoading,
	isError,
	refetch,
	children,
	isFetching,
	className,
	isEmpty,
	emptyMessage,
	useSkeletonLoading = true,
	loadingText = "Loading...",
	noDataText = "No data available",
	refreshText = "Refresh data",
}: AsyncDataWrapperProps) => {
	if (isError) {
		return (
			<div
				className={cn("h-full flex items-center justify-center p-8", className)}
			>
				<ErrorState error={isError} onRetry={() => refetch()} />
			</div>
		);
	}

	if (isLoading) {
		if (useSkeletonLoading) {
			const skeletonRows = [
				"skeleton-1",
				"skeleton-2",
				"skeleton-3",
				"skeleton-4",
				"skeleton-5",
			];

			return (
				<div
					className={cn(
						"relative h-full w-full overflow-hidden p-4 space-y-4",
						className,
					)}
				>
					{/* Background Skeletons */}
					<div className="space-y-4 opacity-50">
						{skeletonRows.map((key) => (
							<Skeleton key={key} className="h-16 w-full rounded-lg" />
						))}
					</div>

					{/* Centered Spinner */}
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10">
						<Spinner size="lg" />
						<div className="text-muted-foreground font-medium">
							{loadingText}
						</div>
					</div>
				</div>
			);
		}

		// Simple spinner fallback
		return (
			<div
				className={cn(
					"flex flex-col h-64 items-center justify-center gap-2",
					className,
				)}
			>
				<Spinner size="lg" />
				<div className="text-muted-foreground">{loadingText}</div>
			</div>
		);
	}

	if (isEmpty) {
		return (
			<div
				className={cn(
					"flex flex-col h-64 items-center justify-center gap-4 text-center p-8 border-2 border-dashed rounded-lg bg-muted/20",
					className,
				)}
			>
				<div className="text-muted-foreground">
					{emptyMessage || noDataText}
				</div>
				<button
					type="button"
					onClick={() => refetch()}
					className="text-sm text-primary hover:underline hover:text-primary/80 transition-colors"
				>
					{refreshText}
				</button>
			</div>
		);
	}

	// Success state
	return (
		<div className={cn("relative", className)}>
			{isFetching && !isLoading && (
				<div className="absolute right-4 top-3 flex items-center gap-2 text-xs text-muted-foreground z-20 pointer-events-none">
					<Spinner size="sm" variant="secondary" />
					<span>{loadingText}</span>
				</div>
			)}
			{children}
		</div>
	);
};
