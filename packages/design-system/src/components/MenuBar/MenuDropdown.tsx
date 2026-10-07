import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface IMenuItem {
	label: string;
	icon?: React.ReactNode;
	shortcut?: string;
	/**
	 * Unique identifier for the action.
	 * If provided, this ID will be passed to the `onAction` handler of the MenuBar.
	 */
	action?: string;
	/**
	 * Direct click handler.
	 * If provided, this will be called instead of (or in addition to) the global `onAction`.
	 */
	onClick?: () => void;
	children?: IMenuItem[];
	disabled?: boolean;
	separator?: boolean;
}

interface IMenuDropdownProps {
	items: IMenuItem[];
	isOpen: boolean;
	onClose: () => void;
	/** Global handler for menu actions */
	onAction?: (actionId: string) => void;
	anchorRect: DOMRect | null;
	parentDepth?: number;
	submenu?: boolean;
}

export const MenuDropdown: React.FC<IMenuDropdownProps> = ({
	items,
	isOpen,
	onClose,
	onAction,
	anchorRect,
	submenu = false,
}) => {
	const menuRef = useRef<HTMLDivElement>(null);
	const [activeSubmenuIndex, setActiveSubmenuIndex] = useState<number | null>(
		null,
	);
	const [submenuAnchor, setSubmenuAnchor] = useState<DOMRect | null>(null);

	useEffect(() => {
		if (!isOpen) {
			setActiveSubmenuIndex(null);
		}
	}, [isOpen]);

	if (!isOpen || !anchorRect) return null;

	// Calculate position
	const style: React.CSSProperties = {
		position: "fixed",
		zIndex: 1000 + (submenu ? 1 : 0),
		minWidth: "200px",
	};

	// Smart Positioning
	const MENU_WIDTH = 220; // Estimated or min-width

	if (submenu) {
		// Default: Open to the right
		style.left = anchorRect.right - 4;
		style.top = anchorRect.top - 4;

		// Check overflow
		if (anchorRect.right + MENU_WIDTH > window.innerWidth) {
			// Flip to left
			style.left = anchorRect.left - MENU_WIDTH + 4;
		}
	} else {
		// Default: Open aligned to left of anchor
		style.top = anchorRect.bottom;
		style.left = anchorRect.left;

		// Check overflow (Top-level)
		if (anchorRect.left + MENU_WIDTH > window.innerWidth) {
			// Align right edge with anchor right edge (or window right)
			// style.left = anchorRect.right - MENU_WIDTH;
			// Or even better, force it to fit
			style.left = Math.min(
				anchorRect.left,
				window.innerWidth - MENU_WIDTH - 8,
			);
		}
	}

	const handleItemEnter = (
		index: number,
		event: React.MouseEvent<HTMLButtonElement>,
	) => {
		const item = items[index];
		if (item?.children) {
			setActiveSubmenuIndex(index);
			setSubmenuAnchor(event.currentTarget.getBoundingClientRect());
		} else {
			setActiveSubmenuIndex(null);
		}
	};

	return createPortal(
		<div
			ref={menuRef}
			style={style}
			className="menu-dropdown flex flex-col bg-background/90 backdrop-blur-md rounded-lg shadow-xl border border-border py-1.5 text-ui font-medium animate-in fade-in zoom-in-95 duration-100"
		>
			{items.map((item, index) => {
				if (item.separator) {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: Separators do not have unique IDs and order is static
						<div key={`sep-${index}`} className="h-[1px] bg-border my-1 mx-3" />
					);
				}

				return (
					<React.Fragment key={item.label}>
						<button
							type="button"
							className={`
                group flex items-center justify-between px-ui py-ui mx-1 rounded-md text-left text-ui
                ${item.disabled ? "opacity-50 cursor-default" : "hover:bg-accent hover:text-accent-foreground cursor-pointer"}
                ${activeSubmenuIndex === index ? "bg-accent text-accent-foreground" : "text-foreground"}
              `}
							onClick={(e) => {
								if (item.disabled) return;
								if (item.children) return;

								item.onClick?.();
								if (item.action && onAction) {
									onAction(item.action);
								}

								onClose();
								e.stopPropagation();
							}}
							onMouseEnter={(e) => handleItemEnter(index, e)}
						>
							<div className="flex items-center gap-2">
								{item.icon && (
									<span className="w-[var(--ui-icon-size)] h-[var(--ui-icon-size)] flex items-center justify-center">
										{item.icon}
									</span>
								)}
								<span>{item.label}</span>
							</div>
							<div className="flex items-center gap-2 ml-4">
								{item.shortcut && (
									<span className="text-xs opacity-60 font-light tracking-wide group-hover:text-white">
										{item.shortcut}
									</span>
								)}
								{item.children && (
									<span className="opacity-60 text-[10px] group-hover:text-white">
										▶
									</span>
								)}
							</div>
						</button>

						{/* Recursively render submenu */}
						{item.children && activeSubmenuIndex === index && (
							<MenuDropdown
								items={item.children}
								isOpen={true}
								onClose={onClose}
								onAction={onAction}
								anchorRect={submenuAnchor}
								submenu={true}
							/>
						)}
					</React.Fragment>
				);
			})}
		</div>,
		document.body,
	);
};
