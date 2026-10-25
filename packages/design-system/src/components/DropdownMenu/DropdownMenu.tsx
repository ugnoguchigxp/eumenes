/**
 * シンプルなドロップダウンメニューコンポーネント
 */

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { menuKeyDown } from "../../utils/menuKeyboard";
import { layoutMenu, measureMenu, menuViewport } from "./menuLayout";

type TriggerElementProps = {
	onClick?: (event: React.MouseEvent) => void;
	onKeyDown?: (event: React.KeyboardEvent) => void;
	type?: string;
};

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
		const listRef = useRef<HTMLDivElement>(null);
		const [listStyle, setListStyle] = useState<React.CSSProperties>({});
		const columnRows = useRef(0);
		const previousItems = useRef(items);
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
			const listEl = listRef.current;
			if (!triggerEl || !menuEl || !listEl) return;
			const triggerRect = triggerEl.getBoundingClientRect();
			const viewport = menuViewport();
			const measured = measureMenu(
				menuEl,
				listEl,
				Math.max(minWidthPx, triggerRect.width),
				viewport,
			);
			const layout = layoutMenu(triggerRect, measured, viewport, {
				align,
				side,
				autoFlip,
				autoSide,
				offset,
				minWidthPx,
			});
			columnRows.current = layout.columnRows;
			setMenuStyle(layout.menuStyle);
			setListStyle(layout.listStyle);
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
			window.visualViewport?.addEventListener("resize", schedule);
			window.visualViewport?.addEventListener("scroll", schedule);

			const menuEl = menuRef.current;
			const ro = menuEl
				? new ResizeObserver(() => {
						schedule();
					})
				: null;
			if (menuEl && ro) ro.observe(menuEl);
			if (listRef.current && ro) ro.observe(listRef.current);

			return () => {
				if (raf) window.cancelAnimationFrame(raf);
				window.removeEventListener("resize", schedule);
				window.removeEventListener("scroll", schedule, true);
				window.visualViewport?.removeEventListener("resize", schedule);
				window.visualViewport?.removeEventListener("scroll", schedule);
				ro?.disconnect();
			};
		}, [computeMenuPosition, isOpen, prepareHiddenMenuStyle]);

		// Refresh changed entries without hiding the menu or resetting the user's focus.
		useEffect(() => {
			const changed = previousItems.current !== items;
			previousItems.current = items;
			if (isOpen && changed) computeMenuPosition();
		}, [items, isOpen, computeMenuPosition]);

		// Once the menu is placed and visible, focus its first item so arrow keys work at once.
		const menuVisible = menuStyle.visibility === "visible";
		useEffect(() => {
			if (!isOpen || !menuVisible) return;
			menuRef.current
				?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
				?.focus({ preventScroll: true });
		}, [isOpen, menuVisible]);

		useEffect(() => {
			if (!isOpen) return;
			const onKeyDown = (e: KeyboardEvent) => {
				if (e.key !== "Escape") return;
				setIsOpen(false);
				triggerRef.current?.focus();
			};
			window.addEventListener("keydown", onKeyDown);
			return () => window.removeEventListener("keydown", onKeyDown);
		}, [isOpen]);

		const handleItemClick = (item: IDropdownMenuItem) => {
			item.onClick();
			setIsOpen(false);
			triggerRef.current?.focus();
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

		const triggerElement = React.isValidElement<TriggerElementProps>(
			trigger,
		) ? (
			React.cloneElement(trigger, {
				...triggerProps,
				onClick: (event: React.MouseEvent) => {
					trigger.props.onClick?.(event);
					handleTriggerClick(event);
				},
				onKeyDown: (event: React.KeyboardEvent) => {
					trigger.props.onKeyDown?.(event);
					handleTriggerKeyDown(event);
				},
				...(trigger.type === "button" ? { type: "button" } : {}),
			})
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
							tabIndex={-1}
							onKeyDown={(event) => {
								if (
									columnRows.current &&
									(event.key === "ArrowLeft" || event.key === "ArrowRight")
								) {
									const buttons = Array.from(
										event.currentTarget.querySelectorAll<HTMLElement>(
											'[role="menuitem"]',
										),
									);
									const current = buttons.indexOf(
										document.activeElement as HTMLElement,
									);
									const rows = columnRows.current;
									const next =
										event.key === "ArrowRight" && current < rows
											? Math.min(current + rows, buttons.length - 1)
											: event.key === "ArrowLeft" && current >= rows
												? current - rows
												: current;
									event.preventDefault();
									buttons[next]?.focus();
								} else menuKeyDown(event);
							}}
							style={menuStyle}
							className="rounded-md border border-border bg-background shadow-lg"
						>
							<div
								ref={listRef}
								style={listStyle}
								className="py-[var(--ui-component-padding-y)]"
							>
								{items.map((item, index) => (
									<button
										// Labels may repeat, so the position keeps keys unique.
										key={`${index}:${item.label}`}
										type="button"
										role="menuitem"
										onClick={() => handleItemClick(item)}
										className="flex min-w-0 w-full items-center gap-ui px-ui text-left text-ui text-foreground hover:bg-accent focus-visible:bg-accent focus:outline-none min-h-[var(--ui-list-row-height)]"
									>
										{item.icon && (
											<span className="text-muted-foreground">{item.icon}</span>
										)}
										<span className="min-w-0 [overflow-wrap:anywhere]">
											{item.label}
										</span>
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
