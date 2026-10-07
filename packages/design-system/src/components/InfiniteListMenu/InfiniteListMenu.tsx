import * as React from "react";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/utils/cn";
import { AdaptiveText } from "../AdaptiveText/AdaptiveText";

export interface InfiniteListMenuItem {
	id: string;
	label: React.ReactNode;
	description?: React.ReactNode;
	icon?: React.ReactNode;
	badge?: React.ReactNode;
	meta?: React.ReactNode;
	disabled?: boolean;
}

export interface InfiniteListMenuProps {
	title?: string;
	items?: InfiniteListMenuItem[];
	selectedId?: string;
	onSelect?: (id: string, item: InfiniteListMenuItem) => void;
	onLoadMore?: () => void;
	hasMore?: boolean;
	isLoading?: boolean;
	loadMoreOffset?: number;
	emptyText?: string;
	loadingText?: string;
	endText?: string;
	headerMeta?: React.ReactNode;
	hideHeader?: boolean;
	resizable?: boolean;
	resizeMinWidth?: number;
	resizeMaxWidth?: number | string;
	className?: string;
	listClassName?: string;
	showDividers?: boolean;
	enableAdaptiveText?: boolean;
	width?: number | string;
	onResize?: (width: number) => void;
	selectedItem?: InfiniteListMenuItem | null;
}

export const InfiniteListMenu: React.FC<InfiniteListMenuProps> = ({
	title = "List",
	items,
	selectedId,
	onSelect,
	onLoadMore,
	hasMore = false,
	isLoading = false,
	loadMoreOffset = 120,
	emptyText = "No items available.",
	loadingText = "Loading more...",
	endText = "All items loaded.",
	headerMeta,
	hideHeader = false,
	resizable = false,
	resizeMinWidth = 240,
	resizeMaxWidth = "100%",
	className,
	listClassName,
	showDividers = false,
	enableAdaptiveText = false,
	width: controlledWidth,
	onResize,
	selectedItem,
}) => {
	const containerRef = React.useRef<HTMLDivElement>(null);
	const scrollRef = React.useRef<HTMLDivElement>(null);
	const loadMoreRequestedRef = React.useRef(false);
	const itemsLength = items?.length ?? 0;
	const hasItems = itemsLength > 0;

	// Resize state for uncontrolled mode
	const [internalWidth, setInternalWidth] = React.useState<number | undefined>(
		undefined,
	);
	const isResizing = React.useRef(false);

	// Determine effective width: prioritizes controlled width
	const width = controlledWidth !== undefined ? controlledWidth : internalWidth;

	const maybeLoadMore = React.useCallback(() => {
		if (!onLoadMore || !hasMore || isLoading) return;
		if (loadMoreRequestedRef.current) return;
		const el = scrollRef.current;
		if (!el) return;
		const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distanceToBottom <= loadMoreOffset) {
			loadMoreRequestedRef.current = true;
			onLoadMore();
		}
	}, [hasMore, isLoading, loadMoreOffset, onLoadMore]);

	React.useEffect(() => {
		if (!isLoading) loadMoreRequestedRef.current = false;
	}, [isLoading]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset loadMoreRequestedRef when itemsLength changes
	React.useEffect(() => {
		loadMoreRequestedRef.current = false;
	}, [itemsLength]);

	React.useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => maybeLoadMore();
		el.addEventListener("scroll", onScroll, { passive: true });
		maybeLoadMore();
		return () => {
			el.removeEventListener("scroll", onScroll);
		};
	}, [maybeLoadMore]);

	React.useEffect(() => {
		if (itemsLength > 0 || hasMore) {
			maybeLoadMore();
		}
	}, [hasMore, itemsLength, maybeLoadMore]);

	// Resize logic
	const handleMouseDown = (e: React.MouseEvent) => {
		if (!resizable) return;
		e.preventDefault();
		isResizing.current = true;
		const startX = e.clientX;
		// Use current rendered width as starting point
		const startWidth = containerRef.current?.getBoundingClientRect().width || 0;

		const handleMouseMove = (e: MouseEvent) => {
			if (!isResizing.current) return;
			const deltaX = e.clientX - startX;
			let newWidth = startWidth + deltaX;

			if (typeof resizeMinWidth === "number") {
				newWidth = Math.max(newWidth, resizeMinWidth);
			}
			if (typeof resizeMaxWidth === "number") {
				newWidth = Math.min(newWidth, resizeMaxWidth);
			}

			if (controlledWidth !== undefined) {
				onResize?.(newWidth);
			} else {
				setInternalWidth(newWidth);
			}
		};

		const handleMouseUp = () => {
			isResizing.current = false;
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
	};

	const rowPaddingClass = "px-ui py-ui";

	return (
		<div
			ref={containerRef}
			className={cn(
				"relative h-full min-h-0 flex flex-col transition-width duration-0", // duration-0 to avoid lag during drag
				resizable || width !== undefined ? "flex-none" : "w-full",
				className,
			)}
			style={
				resizable || width !== undefined
					? {
							width: width,
							minWidth: resizeMinWidth,
							maxWidth: resizeMaxWidth,
						}
					: undefined
			}
		>
			{!hideHeader && (
				<div className="flex items-center bg-primary px-ui py-ui w-full mb-2 shrink-0 flex-nowrap">
					<div className="flex items-center font-bold flex-grow ps-2 text-primary-foreground min-w-0">
						<span className="truncate">{title}</span>
					</div>
					{headerMeta && (
						<div className="text-xs text-primary-foreground/80 shrink-0 ml-2">
							{headerMeta}
						</div>
					)}
				</div>
			)}
			<div
				ref={scrollRef}
				data-testid="infinite-list-menu-scroll"
				className={cn(
					"bg-background w-full flex-1 min-h-0 overflow-y-auto",
					listClassName,
				)}
			>
				{hasItems ? (
					<div
						role="listbox"
						className={cn(
							!showDividers && "space-y-0.5",
							showDividers && "divide-y divide-border",
						)}
					>
						{(items ?? []).map((item) => {
							const isSelected = selectedItem
								? selectedItem.id === item.id
								: selectedId === item.id;
							return (
								<button
									key={item.id}
									type="button"
									role="option"
									aria-selected={isSelected}
									disabled={item.disabled}
									aria-disabled={item.disabled || undefined}
									onClick={() => onSelect?.(item.id, item)}
									className={cn(
										"w-full flex items-center gap-3 transition-colors duration-150 text-start",
										rowPaddingClass,
										"text-sm",
										item.disabled && "opacity-50 pointer-events-none",
										isSelected
											? "bg-primary text-primary-foreground font-semibold"
											: "hover:bg-primary/20 hover:text-foreground",
										!showDividers && "rounded-md", // removing rounded-md if dividers are shown usually looks better, but let's keep it consistent or check user preference.
										// If showing dividers, usually we don't have gaps. The original had space-y-0.5.
										// If showDividers is true, we should probably remove space-y-0.5 or set it to 0.
									)}
								>
									{item.icon && (
										<span
											className={cn(
												"shrink-0",
												isSelected
													? "text-primary-foreground"
													: "text-muted-foreground",
											)}
										>
											{item.icon}
										</span>
									)}
									<span className="min-w-0 flex-1">
										<span className="block truncate">
											{enableAdaptiveText && typeof item.label === "string" ? (
												<AdaptiveText text={item.label} />
											) : (
												item.label
											)}
										</span>
										{item.description && (
											<span className="block truncate text-xs text-muted-foreground">
												{item.description}
											</span>
										)}
									</span>
									{item.meta !== undefined && (
										<span
											className={cn(
												"text-xs",
												isSelected
													? "text-primary-foreground/80"
													: "text-muted-foreground",
											)}
										>
											{item.meta}
										</span>
									)}
									{item.badge !== undefined && (
										<span
											className={cn(
												"ms-2 text-xs px-2 py-0.5 rounded",
												isSelected
													? "bg-primary-foreground/20 text-primary-foreground"
													: "bg-muted text-muted-foreground",
											)}
										>
											{item.badge}
										</span>
									)}
								</button>
							);
						})}
					</div>
				) : (
					<div className="px-ui py-ui">
						{isLoading ? (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Spinner size="xs" variant="secondary" />
								<span>{loadingText}</span>
							</div>
						) : (
							<div className="text-xs text-muted-foreground">{emptyText}</div>
						)}
					</div>
				)}

				{hasItems && (
					<div className="px-ui py-ui">
						{isLoading ? (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Spinner size="xs" variant="secondary" />
								<span>{loadingText}</span>
							</div>
						) : !hasMore ? (
							<div className="text-xs text-muted-foreground">{endText}</div>
						) : null}
					</div>
				)}
			</div>
			{resizable && (
				<div
					data-testid="infinite-list-menu-resize-handle"
					className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 z-50 transition-colors"
					onMouseDown={handleMouseDown}
					aria-hidden="true"
				/>
			)}
		</div>
	);
};

export default InfiniteListMenu;
