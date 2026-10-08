/**
 * シンプルなドロップダウンメニューコンポーネント
 */

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface IDropdownMenuItem {
	label: string;
	onClick: () => void;
	icon?: React.ReactNode;
}

export interface IDropdownMenuProps {
	trigger: React.ReactNode;
	items: IDropdownMenuItem[];
	/**
	 * Preferred horizontal alignment. When `autoFlip` is true, this may be flipped to avoid overflow.
	 */
	align?: "left" | "right";
	/**
	 * Preferred vertical side. When `autoSide` is true, this may open upward if there's not enough space.
	 */
	side?: "bottom" | "top";
	/**
	 * Auto flip left/right when near screen edge.
	 * Default: true
	 */
	autoFlip?: boolean;
	/**
	 * Auto choose top/bottom based on available space.
	 * Default: true
	 */
	autoSide?: boolean;
	/**
	 * Distance in pixels between trigger and menu.
	 * Default: 8
	 */
	offset?: number;
	/**
	 * Minimum width for the menu.
	 * Default: 160
	 */
	minWidthPx?: number;
	className?: string;
}

/**
 * ドロップダウンメニュー
 */
export const DropdownMenu: React.FC<IDropdownMenuProps> = React.memo(
	({
		trigger,
		items,
		align = "left",
		side = "bottom",
		autoFlip = true,
		autoSide = true,
		offset = 8,
		minWidthPx = 160,
		className = "",
	}) => {
		const [isOpen, setIsOpen] = useState(false);
		const triggerRef = useRef<HTMLElement | null>(null);
		const menuRef = useRef<HTMLDivElement>(null);
		const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({
			position: "fixed",
			top: -9999,
			left: -9999,
			visibility: "hidden",
			zIndex: 50,
		});

		const prepareHiddenMenuStyle = React.useCallback(() => {
			const triggerEl = triggerRef.current;
			const anchorRect = triggerEl?.getBoundingClientRect();
			const initialMinWidth = anchorRect
				? Math.max(minWidthPx, anchorRect.width)
				: minWidthPx;

			setMenuStyle({
				position: "fixed",
				top: -9999,
				left: -9999,
				minWidth: initialMinWidth,
				visibility: "hidden",
				zIndex: 50,
			});
		}, [minWidthPx]);

		const computeMenuPosition = React.useCallback(() => {
			const triggerEl = triggerRef.current;
			const menuEl = menuRef.current;
			if (!triggerEl || !menuEl) return;

			const triggerRect = triggerEl.getBoundingClientRect();
			const menuRect = menuEl.getBoundingClientRect();

			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const margin = 8;

			const spaceBelow = vh - triggerRect.bottom - margin;
			const spaceAbove = triggerRect.top - margin;

			let resolvedSide: "bottom" | "top" = side;
			if (autoSide) {
				if (spaceBelow >= menuRect.height) {
					resolvedSide = "bottom";
				} else if (spaceAbove >= menuRect.height) {
					resolvedSide = "top";
				} else {
					resolvedSide = spaceBelow >= spaceAbove ? "bottom" : "top";
				}
			}

			const minWidth = Math.max(minWidthPx, triggerRect.width);

			let top =
				resolvedSide === "bottom"
					? triggerRect.bottom + offset
					: triggerRect.top - menuRect.height - offset;

			const menuWidth = Math.max(menuRect.width, minWidth);
			const leftAlignLeft = triggerRect.left;
			const leftAlignRight = triggerRect.right - menuWidth;

			let resolvedAlign: "left" | "right" = align;

			if (autoFlip) {
				const preferredLeft = align === "left" ? leftAlignLeft : leftAlignRight;
				const preferredOverflowsLeft = preferredLeft < margin;
				const preferredOverflowsRight = preferredLeft + menuWidth > vw - margin;

				const flipIsUseful =
					(align === "left" && preferredOverflowsRight) ||
					(align === "right" && preferredOverflowsLeft);

				if (flipIsUseful) {
					resolvedAlign = align === "left" ? "right" : "left";
				} else if (preferredOverflowsLeft || preferredOverflowsRight) {
					// If overflow exists but flip would not help (e.g. near right edge with align=right),
					// keep alignment and clamp to stay near the trigger.
					resolvedAlign = align;
				}
			}

			const leftUnclamped =
				resolvedAlign === "left" ? leftAlignLeft : leftAlignRight;
			const left = Math.min(
				vw - margin - menuWidth,
				Math.max(margin, leftUnclamped),
			);

			if (autoSide) {
				if (resolvedSide === "bottom" && top + menuRect.height > vh - margin) {
					const flippedTop = triggerRect.top - menuRect.height - offset;
					if (flippedTop >= margin) top = flippedTop;
				} else if (resolvedSide === "top" && top < margin) {
					const flippedBottom = triggerRect.bottom + offset;
					if (flippedBottom + menuRect.height <= vh - margin)
						top = flippedBottom;
				}
			}

			const maxHeight =
				resolvedSide === "bottom"
					? Math.max(120, vh - top - margin)
					: Math.max(120, triggerRect.top - margin);

			setMenuStyle({
				position: "fixed",
				top,
				left,
				minWidth,
				maxHeight,
				overflowY: "auto",
				zIndex: 50,
				visibility: "visible",
			});
		}, [align, autoFlip, autoSide, minWidthPx, offset, side]);

		// 外側クリックで閉じる
		useEffect(() => {
			const handleClickOutside = (event: MouseEvent) => {
				const target = event.target as Node;
				if (
					isOpen &&
					!triggerRef.current?.contains(target) &&
					!menuRef.current?.contains(target)
				) {
					setIsOpen(false);
				}
			};

			if (isOpen) {
				document.addEventListener("mousedown", handleClickOutside);
			}

			return () => {
				document.removeEventListener("mousedown", handleClickOutside);
			};
		}, [isOpen]);

		useEffect(() => {
			if (!isOpen) return;

			let raf = 0;
			const schedule = () => {
				if (raf) return;
				raf = window.requestAnimationFrame(() => {
					raf = 0;
					computeMenuPosition();
				});
			};

			// Ensure we never flash at body origin on first paint
			prepareHiddenMenuStyle();
			schedule();
			window.addEventListener("resize", schedule);
			window.addEventListener("scroll", schedule, true);

			const menuEl = menuRef.current;
			const ro = menuEl
				? new ResizeObserver(() => {
						schedule();
					})
				: null;
			if (menuEl && ro) ro.observe(menuEl);

			return () => {
				if (raf) window.cancelAnimationFrame(raf);
				window.removeEventListener("resize", schedule);
				window.removeEventListener("scroll", schedule, true);
				ro?.disconnect();
			};
		}, [computeMenuPosition, isOpen, prepareHiddenMenuStyle]);

		useEffect(() => {
			if (!isOpen) return;
			const onKeyDown = (e: KeyboardEvent) => {
				if (e.key === "Escape") setIsOpen(false);
			};
			window.addEventListener("keydown", onKeyDown);
			return () => window.removeEventListener("keydown", onKeyDown);
		}, [isOpen]);

		const handleItemClick = (item: IDropdownMenuItem) => {
			item.onClick();
			setIsOpen(false);
		};

		const toggleMenu = () => {
			setIsOpen((prev) => {
				if (!prev) prepareHiddenMenuStyle();
				return !prev;
			});
		};

		const handleTriggerClick = (event?: React.MouseEvent) => {
			if (event?.defaultPrevented) return;
			toggleMenu();
		};

		const handleTriggerKeyDown = (event: React.KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				toggleMenu();
			}
		};

		const triggerProps = {
			"aria-haspopup": "menu",
			"aria-expanded": isOpen,
			onClick: handleTriggerClick,
			onKeyDown: handleTriggerKeyDown,
			ref: (node: HTMLElement | null) => {
				triggerRef.current = node;
			},
		} as const;

		const triggerElement = React.isValidElement(trigger) ? (
			React.cloneElement(trigger, {
				...triggerProps,
				onClick: (event: React.MouseEvent) => {
					/* biome-ignore lint/suspicious/noExplicitAny: Safely accessing props of cloned element */
					(trigger as any).props?.onClick?.(event);
					handleTriggerClick(event);
				},
				onKeyDown: (event: React.KeyboardEvent) => {
					/* biome-ignore lint/suspicious/noExplicitAny: Safely accessing props of cloned element */
					(trigger as any).props?.onKeyDown?.(event);
					handleTriggerKeyDown(event);
				},
				...((trigger as React.ReactElement).type === "button"
					? { type: "button" }
					: {}),
			} as React.HTMLAttributes<HTMLElement>)
		) : (
			<button type="button" {...triggerProps}>
				{trigger}
			</button>
		);

		return (
			<div className={className}>
				{/* Trigger */}
				<div style={{ display: "inline-block" }}>{triggerElement}</div>

				{/* Menu */}
				{isOpen &&
					createPortal(
						<div
							ref={menuRef}
							role="menu"
							style={menuStyle}
							className="rounded-md border border-border bg-background shadow-lg"
						>
							<div className="py-[var(--ui-component-padding-y)]">
								{items.map((item) => (
									<button
										key={item.label}
										type="button"
										role="menuitem"
										onClick={() => handleItemClick(item)}
										className="flex w-full items-center gap-ui px-ui text-left text-ui text-foreground hover:bg-accent focus:bg-accent focus:outline-none min-h-[var(--ui-list-row-height)]"
									>
										{item.icon && (
											<span className="text-muted-foreground">{item.icon}</span>
										)}
										<span>{item.label}</span>
									</button>
								))}
							</div>
						</div>,
						document.body,
					)}
			</div>
		);
	},
);
