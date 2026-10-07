import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Minus,
	Plus,
} from "lucide-react";
import React from "react";
import { cn } from "@/utils/cn";

const isClient = typeof document !== "undefined";
const getIsRtl = (): boolean => {
	if (!isClient) return false;
	return (
		document.documentElement.dir === "rtl" ||
		document.documentElement.getAttribute("data-rtl") === "true"
	);
};

export interface TreeMenuItem {
	id: string;
	label: React.ReactNode;
	icon?: React.ReactNode;
	disabled?: boolean;
	badge?: React.ReactNode;
	children?: TreeMenuItem[];
}

export interface TreeMenuProps {
	title?: string;
	items?: TreeMenuItem[];
	selectedId?: string;
	onSelect?: (id: string, item: TreeMenuItem) => void;
	/** Uncontrolled expanded state */
	defaultExpandedIds?: string[];
	/** Controlled expanded state */
	expandedIds?: string[];
	onExpandedChange?: (expandedIds: string[]) => void;
	dense?: boolean;
	className?: string;

	// Restoration props
	showCloseButton?: boolean;
	onCloseMenu?: () => void;
	hideControlBar?: boolean;
}

const toSet = (values: string[] | undefined) => new Set(values ?? []);

export const TreeMenu: React.FC<TreeMenuProps> = ({
	title = "Menu",
	items,
	selectedId,
	onSelect,
	defaultExpandedIds,
	expandedIds,
	onExpandedChange,
	// dense = false, // Removed unused prop
	className,
	// Restoration props
	showCloseButton = false,
	onCloseMenu,
	hideControlBar = false,
}) => {
	const isRtl = getIsRtl();

	// Collect all IDs for expand/collapse all
	const allIds = React.useMemo(() => {
		const ids: string[] = [];
		const traverse = (nodes: TreeMenuItem[]) => {
			nodes.forEach((node) => {
				if (node.children && node.children.length > 0) {
					ids.push(node.id);
					traverse(node.children);
				}
			});
		};
		if (items) traverse(items);
		return ids;
	}, [items]);

	const [uncontrolledExpanded, setUncontrolledExpanded] = React.useState<
		string[]
	>(defaultExpandedIds ?? []);

	const isControlled = expandedIds !== undefined;
	const expanded = isControlled ? expandedIds : uncontrolledExpanded;
	const expandedSet = React.useMemo(() => toSet(expanded), [expanded]);

	const setExpanded = React.useCallback(
		(next: string[]) => {
			if (!isControlled) setUncontrolledExpanded(next);
			onExpandedChange?.(next);
		},
		[isControlled, onExpandedChange],
	);

	const toggleExpanded = React.useCallback(
		(id: string) => {
			const next = new Set(expandedSet);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			setExpanded(Array.from(next));
		},
		[expandedSet, setExpanded],
	);

	const expandAll = () => setExpanded(allIds);
	const collapseAll = () => setExpanded([]);

	const rowPaddingClass = "px-ui py-ui";

	const renderItems = (nodes: TreeMenuItem[], level: number) => {
		return (
			<ul role={level === 0 ? "tree" : "group"} className="space-y-0.5">
				{nodes.map((item) => {
					const hasChildren = (item.children?.length ?? 0) > 0;
					const isExpanded = hasChildren && expandedSet.has(item.id);
					const isSelected = selectedId === item.id;

					const indentPx = 8 + level * 16;

					return (
						<li
							key={item.id}
							role="treeitem"
							aria-expanded={hasChildren ? isExpanded : undefined}
							aria-selected={isSelected || undefined}
							tabIndex={item.disabled ? -1 : 0}
						>
							<div
								className={cn(
									"w-full flex items-center gap-2 rounded-md transition-colors duration-150",
									rowPaddingClass,
									"text-foreground",
									item.disabled && "opacity-50 pointer-events-none",
									isSelected
										? "bg-primary text-primary-foreground font-semibold"
										: "hover:bg-primary/20 hover:text-foreground",
								)}
								style={{
									paddingInlineStart: indentPx,
								}}
							>
								{hasChildren ? (
									<button
										type="button"
										className="flex-1 flex items-center min-w-0 text-start cursor-pointer focus:outline-none"
										onClick={() => toggleExpanded(item.id)}
									>
										{item.icon && (
											<span
												className={cn(
													"me-2",
													isSelected
														? "text-primary-foreground"
														: "text-muted-foreground",
												)}
											>
												{item.icon}
											</span>
										)}
										<span className={cn("truncate flex-grow", "text-ui")}>
											{item.label}
										</span>
									</button>
								) : (
									<button
										type="button"
										className="flex-1 flex items-center min-w-0 text-start cursor-pointer focus:outline-none"
										onClick={() => onSelect?.(item.id, item)}
									>
										{item.icon && (
											<span
												className={cn(
													"me-2",
													isSelected
														? "text-primary-foreground"
														: "text-muted-foreground",
												)}
											>
												{item.icon}
											</span>
										)}
										<span className={cn("truncate flex-grow", "text-ui")}>
											{item.label}
										</span>
									</button>
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

								{hasChildren && (
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											toggleExpanded(item.id);
										}}
										className={cn(
											"w-7 aspect-square flex items-center justify-center rounded focus:outline-none",
											isSelected
												? "text-primary-foreground hover:text-primary-foreground/80"
												: "text-foreground hover:text-accent-foreground",
										)}
										aria-label={isExpanded ? "Collapse" : "Expand"}
									>
										{isExpanded ? (
											<ChevronDown size={16} />
										) : isRtl ? (
											<ChevronLeft size={16} />
										) : (
											<ChevronRight size={16} />
										)}
									</button>
								)}
							</div>

							{hasChildren && isExpanded && item.children ? (
								<div className="mt-0.5">
									{renderItems(item.children, level + 1)}
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
		);
	};

	const headerTextColor = "text-primary-foreground";
	const headerHoverColor = "hover:text-primary-foreground/80";

	return (
		<div
			className={cn("w-full relative h-full min-h-0 flex flex-col", className)}
		>
			{!hideControlBar && (
				<div className="flex items-center bg-primary px-ui py-ui w-full mb-2">
					{showCloseButton && onCloseMenu && (
						<button
							type="button"
							aria-label="Close menu"
							className={cn(
								"min-w-[32px] focus:outline-none",
								headerTextColor,
								headerHoverColor,
							)}
							onClick={onCloseMenu}
						>
							{isRtl ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
						</button>
					)}
					<div
						className={cn(
							"flex items-center font-bold flex-grow ps-2",
							headerTextColor,
						)}
					>
						{title}
					</div>
					<div className="flex items-center space-x-2">
						<button
							type="button"
							onClick={expandAll}
							className={cn(
								"focus:outline-none",
								headerTextColor,
								headerHoverColor,
							)}
							aria-label="Expand all"
						>
							<Plus size={"0.8rem"} />
						</button>
						<button
							type="button"
							onClick={collapseAll}
							className={cn(
								"focus:outline-none",
								headerTextColor,
								headerHoverColor,
							)}
							aria-label="Collapse all"
						>
							<Minus size={"0.8rem"} />
						</button>
					</div>
				</div>
			)}
			<div className="bg-background w-full flex-1 min-h-0 overflow-y-auto">
				{items && items.length > 0 ? (
					renderItems(items, 0)
				) : (
					<div className="text-xs text-muted-foreground px-ui py-ui">
						TreeMenu items not provided.
					</div>
				)}
			</div>
		</div>
	);
};

export default TreeMenu;
