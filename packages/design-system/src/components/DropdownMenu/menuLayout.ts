import type { CSSProperties } from "react";

export type MenuPlacement = {
	align: "left" | "right";
	side: "bottom" | "top";
	autoFlip: boolean;
	autoSide: boolean;
	offset: number;
	minWidthPx: number;
};
export type Viewport = {
	left: number;
	top: number;
	width: number;
	height: number;
};
export type MenuSize = {
	width: number;
	height: number;
	rowHeight: number;
	chrome: number;
	count: number;
};
const margin = 8;

export function menuViewport(): Viewport {
	const visual = window.visualViewport;
	return {
		left: visual?.offsetLeft ?? 0,
		top: visual?.offsetTop ?? 0,
		width: visual?.width ?? window.innerWidth,
		height: visual?.height ?? window.innerHeight,
	};
}

/** Measure the single-column layout each time, so a previous split cannot feed back into the next one. */
export function measureMenu(
	menu: HTMLElement,
	list: HTMLElement,
	minWidth: number,
	viewport: Viewport,
): MenuSize {
	const menuStyle = menu.style.cssText;
	const listStyle = list.style.cssText;
	const scrollTop = menu.scrollTop;
	try {
		Object.assign(menu.style, {
			width: "max-content",
			minWidth: `${Math.min(minWidth, Math.max(0, viewport.width - margin * 2))}px`,
			maxWidth: `${Math.max(0, viewport.width - margin * 2)}px`,
			maxHeight: "none",
			overflow: "visible",
		});
		list.style.display = "block";
		const rect = menu.getBoundingClientRect();
		const heights = Array.from(
			list.children,
			(item) => item.getBoundingClientRect().height,
		);
		return {
			width: rect.width,
			height: rect.height,
			rowHeight: Math.max(0, ...heights),
			chrome: Math.max(
				0,
				rect.height - heights.reduce((sum, height) => sum + height, 0),
			),
			count: heights.length,
		};
	} finally {
		menu.style.cssText = menuStyle;
		list.style.cssText = listStyle;
		menu.scrollTop = scrollTop;
	}
}

export function layoutMenu(
	trigger: DOMRect,
	size: MenuSize,
	viewport: Viewport,
	placement: MenuPlacement,
): {
	menuStyle: CSSProperties;
	listStyle: CSSProperties;
	columnRows: number;
} {
	const { align, side, autoFlip, autoSide, offset, minWidthPx } = placement;
	const leftEdge = viewport.left + margin;
	const topEdge = viewport.top + margin;
	const rightEdge = viewport.left + viewport.width - margin;
	const bottomEdge = viewport.top + viewport.height - margin;
	const availableWidth = Math.max(0, viewport.width - margin * 2);
	const below = Math.max(0, bottomEdge - trigger.bottom - offset);
	const above = Math.max(0, trigger.top - offset - topEdge);
	const resolvedSide = !autoSide
		? side
		: below >= size.height
			? "bottom"
			: above >= size.height
				? "top"
				: below >= above
					? "bottom"
					: "top";
	const maxHeight = resolvedSide === "bottom" ? below : above;
	const columnWidth = Math.min(
		availableWidth,
		Math.max(size.width, minWidthPx, trigger.width),
	);
	const split =
		size.height > maxHeight &&
		size.count > 1 &&
		size.rowHeight > 0 &&
		columnWidth * 2 <= availableWidth;
	// Fill the first column down to the available height. If two columns still
	// overflow, distribute the rows between them and keep vertical scrolling.
	const columnRows = split
		? Math.min(
				size.count - 1,
				Math.max(
					Math.ceil(size.count / 2),
					Math.floor((maxHeight - size.chrome) / size.rowHeight),
				),
			)
		: 0;
	const width = columnWidth * (split ? 2 : 1);
	const height = Math.min(
		maxHeight,
		split ? columnRows * size.rowHeight + size.chrome : size.height,
	);
	let left = align === "left" ? trigger.left : trigger.right - width;
	if (autoFlip && (left < leftEdge || left + width > rightEdge)) {
		left = align === "left" ? trigger.right - width : trigger.left;
	}
	return {
		columnRows,
		menuStyle: {
			position: "fixed",
			left: Math.max(leftEdge, Math.min(left, rightEdge - width)),
			top: Math.max(
				topEdge,
				Math.min(
					resolvedSide === "bottom"
						? trigger.bottom + offset
						: trigger.top - offset - height,
					bottomEdge - height,
				),
			),
			width,
			maxWidth: availableWidth,
			maxHeight,
			overflowY: "auto",
			overflowX: "hidden",
			zIndex: 50,
			visibility: "visible",
		},
		listStyle: split
			? {
					display: "grid",
					gridAutoFlow: "column",
					gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
					gridTemplateRows: `repeat(${columnRows}, minmax(${size.rowHeight}px, auto))`,
				}
			: {},
	};
}
