import * as React from "react";
import { cn } from "@/utils/cn";
import { AdaptiveText } from "../AdaptiveText";
import { Button } from "../Button/Button";

export interface ButtonGroupItem {
	label: string;
	icon?: React.ReactNode;
	shortcut?: string;
	action?: string;
	onClick?: () => void;
	disabled?: boolean;
	separator?: boolean;
}

export interface IMenuButtonGroupProps {
	items: ButtonGroupItem[];
	selectedId?: string | null;
	onAction?: (actionId: string) => void;
	className?: string;
	stretchLastRow?: boolean;
	/** @internal Test-only: Force column count for testing stretchLastRow */
	_testColumnCount?: number;
}

/**
 * Calculate optimal column count based on button widths and container width.
 */
export function calculateOptimalColumnCount(
	buttonWidths: number[],
	containerWidth: number,
): number {
	if (buttonWidths.length === 0 || containerWidth <= 0) {
		return buttonWidths.length || 1;
	}

	let cols = buttonWidths.length;
	while (cols > 1) {
		const colMaxWidths: number[] = [];
		for (let c = 0; c < cols; c++) {
			let maxW = 0;
			for (let i = c; i < buttonWidths.length; i += cols) {
				const width = buttonWidths[i];
				if (width !== undefined && width > maxW) maxW = width;
			}
			colMaxWidths.push(maxW);
		}
		const totalWidth = colMaxWidths.reduce((a, b) => a + b, 0);
		if (totalWidth <= containerWidth) {
			break;
		}
		cols--;
	}
	return cols;
}

/**
 * Calculate last row info.
 */
export function calculateLastRowInfo(
	itemCount: number,
	columnCount: number,
): {
	lastRowStartIndex: number;
	lastRowItemCount: number;
	isLastRowFull: boolean;
} {
	if (columnCount <= 0) {
		return {
			lastRowStartIndex: 0,
			lastRowItemCount: itemCount,
			isLastRowFull: true,
		};
	}
	const lastRowStartIndex = Math.floor(itemCount / columnCount) * columnCount;
	const lastRowItemCount = itemCount - lastRowStartIndex;
	const isLastRowFull =
		lastRowItemCount === columnCount || lastRowItemCount === 0;
	return { lastRowStartIndex, lastRowItemCount, isLastRowFull };
}

export const MenuButtonGroup: React.FC<IMenuButtonGroupProps> = ({
	items = [],
	selectedId,
	onAction,
	className,
	stretchLastRow = false,
	_testColumnCount,
}) => {
	const containerRef = React.useRef<HTMLDivElement>(null);
	const measureRef = React.useRef<HTMLDivElement>(null);
	const [columnCount, setColumnCount] = React.useState<number>(
		_testColumnCount ?? 0,
	);
	const [buttonWidths, setButtonWidths] = React.useState<number[]>([]);
	const [isMeasured, setIsMeasured] = React.useState(
		_testColumnCount !== undefined,
	);

	const safeItems = items?.filter((i) => !i.separator) || [];
	const itemsKey = safeItems.map((i) => i.label).join(",");

	// Use test column count if provided
	const effectiveColumnCount = _testColumnCount ?? columnCount;

	// Step 1: Measure button widths (only once)
	/* istanbul ignore next -- @preserve Browser-only DOM measurement */
	React.useEffect(() => {
		if (isMeasured || _testColumnCount !== undefined) return;

		const measureWidths = () => {
			if (!measureRef.current) return;

			const buttons = measureRef.current.querySelectorAll(
				'[data-measure="true"]',
			);
			if (buttons.length === 0) return;

			const widths: number[] = [];
			buttons.forEach((btn) => {
				widths.push((btn as HTMLElement).offsetWidth);
			});

			setButtonWidths(widths);
			setIsMeasured(true);
		};

		const timer = setTimeout(measureWidths, 0);
		return () => clearTimeout(timer);
	}, [isMeasured, _testColumnCount]);

	// Step 2: Calculate column count based on container width and stored widths
	/* istanbul ignore next -- @preserve Browser-only ResizeObserver */
	React.useEffect(() => {
		if (buttonWidths.length === 0 || _testColumnCount !== undefined) return;

		const calculateColumns = () => {
			if (!containerRef.current) return;

			const containerWidth = containerRef.current.offsetWidth;
			if (containerWidth === 0) return;

			const cols = calculateOptimalColumnCount(buttonWidths, containerWidth);
			setColumnCount(cols);
		};

		calculateColumns();

		const observer = new ResizeObserver(calculateColumns);
		if (containerRef.current) {
			observer.observe(containerRef.current);
		}

		return () => observer.disconnect();
	}, [buttonWidths, _testColumnCount]);

	// Reset measurement when items change
	// biome-ignore lint/correctness/useExhaustiveDependencies: Intentionally tracking items change via itemsKey
	React.useEffect(() => {
		if (_testColumnCount !== undefined) return;
		setIsMeasured(false);
		setButtonWidths([]);
		setColumnCount(0);
	}, [itemsKey, _testColumnCount]);

	const handleClick = (item: ButtonGroupItem) => {
		if (item.disabled) return;
		item.onClick?.();
		if (item.action && onAction) {
			onAction(item.action);
		}
	};

	// Calculate last row info
	const { lastRowStartIndex, isLastRowFull } = calculateLastRowInfo(
		safeItems.length,
		effectiveColumnCount,
	);

	// Render buttons
	const renderButton = (
		item: ButtonGroupItem,
		index: number,
		isMeasure: boolean,
	) => {
		const isSelected = selectedId && item.action === selectedId;
		let buttonClass =
			"gap-ui justify-start text-ui rounded-none border-b border-r border-border h-auto py-ui px-ui whitespace-nowrap";

		if (isSelected) {
			buttonClass += " bg-accent text-accent-foreground font-bold";
		} else {
			buttonClass +=
				" text-muted-foreground hover:text-foreground hover:bg-muted";
		}

		const displayLabel =
			item.label.length > 16 ? item.label.slice(0, 16) : item.label;

		return (
			<Button
				key={`${isMeasure ? "measure-" : ""}${item.label}-${index}`}
				variant="ghost"
				disabled={item.disabled}
				onClick={isMeasure ? undefined : () => handleClick(item)}
				className={cn(buttonClass)}
				data-measure={isMeasure ? "true" : undefined}
			>
				{item.icon}
				<AdaptiveText text={displayLabel} />
			</Button>
		);
	};

	// Grid style
	const gridStyle: React.CSSProperties =
		effectiveColumnCount > 0
			? {
					gridTemplateColumns: `repeat(${effectiveColumnCount}, minmax(max-content, 1fr))`,
				}
			: {};

	// For stretchLastRow
	const mainItems =
		stretchLastRow && !isLastRowFull
			? safeItems.slice(0, lastRowStartIndex)
			: safeItems;
	const lastRowItems =
		stretchLastRow && !isLastRowFull ? safeItems.slice(lastRowStartIndex) : [];

	return (
		<>
			{!isMeasured && (
				<div
					ref={measureRef}
					className="absolute invisible flex flex-wrap"
					aria-hidden="true"
					data-testid="measure-container"
				>
					{safeItems.map((item, index) => renderButton(item, index, true))}
				</div>
			)}

			<div
				ref={containerRef}
				className={cn(
					"grid items-center gap-0 border border-border rounded-lg overflow-hidden",
					className,
				)}
				style={gridStyle}
			>
				{mainItems.map((item, index) => renderButton(item, index, false))}

				{lastRowItems.length > 0 &&
					lastRowItems.map((item, index) => {
						const actualIndex = lastRowStartIndex + index;
						const isSelected = selectedId && item.action === selectedId;
						let buttonClass =
							"gap-ui justify-start text-ui rounded-none border-b border-r border-border h-auto py-ui px-ui whitespace-nowrap";

						if (isSelected) {
							buttonClass += " bg-accent text-accent-foreground font-bold";
						} else {
							buttonClass +=
								" text-muted-foreground hover:text-foreground hover:bg-muted";
						}

						const colSpan = Math.ceil(
							effectiveColumnCount / lastRowItems.length,
						);
						const style: React.CSSProperties = {
							gridColumn: `span ${colSpan}`,
						};

						const displayLabel =
							item.label.length > 16 ? item.label.slice(0, 16) : item.label;

						return (
							<Button
								key={`${item.label}-${actualIndex}`}
								variant="ghost"
								disabled={item.disabled}
								onClick={() => handleClick(item)}
								className={cn(buttonClass)}
								style={style}
							>
								{item.icon}
								<AdaptiveText text={displayLabel} />
							</Button>
						);
					})}
			</div>
		</>
	);
};
