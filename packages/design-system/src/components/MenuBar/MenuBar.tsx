import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { type IMenuItem, MenuDropdown } from "./MenuDropdown";

export interface IMenuBarProps {
	menus: IMenuItem[];
	/**
	 * Configuration for the system menu (the first item on the left).
	 * If not provided, it defaults to the Apple logo () and standard system items.
	 */
	systemMenu?: {
		/** Custom icon for the system menu */
		icon?: React.ReactNode;
		/** Custom label for the system menu */
		label?: string; // Text to display alongside or instead of the icon
		/** Custom menu items */
		items?: IMenuItem[];
	};
	/**
	 * Configuration for the application menu (displayed in bold next to the system menu).
	 * This represents the current application context.
	 */
	appMenu?: {
		label: string;
		items: IMenuItem[];
	};
	/**
	 * Callback handler for menu actions.
	 * Triggered when a menu item with an `action` ID is clicked.
	 */
	onAction?: (actionId: string) => void;
	className?: string;
}

export const MenuBar: React.FC<IMenuBarProps> = ({
	menus,
	systemMenu,
	appMenu,
	onAction,
	className = "",
}) => {
	const [activeMenuIndex, setActiveMenuIndex] = useState<number | null>(null);
	const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
	const barRef = useRef<HTMLDivElement>(null);

	// Global click outside to close everything
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			// If clicking on a trigger, that is handled by the trigger click itself
			// If clicking inside the menu, that is handled by the menu or stops propagation
			// This is mainly for clicking completely outside
			// We need to check if the target is NOT part of the mac-menu-dropdowns in the portal

			const target = event.target as HTMLElement;
			if (barRef.current?.contains(target)) return;

			// Simple check: if it's not a menu item or inside a menu
			if (!target.closest(".menu-dropdown")) {
				setActiveMenuIndex(null);
			}
		};

		if (activeMenuIndex !== null) {
			window.addEventListener("mousedown", handleClickOutside);
		}
		return () => window.removeEventListener("mousedown", handleClickOutside);
	}, [activeMenuIndex]);

	const handleMenuClick = (
		index: number,
		event: React.MouseEvent<HTMLButtonElement>,
	) => {
		if (activeMenuIndex === index) {
			setActiveMenuIndex(null);
		} else {
			setActiveMenuIndex(index);
			setAnchorRect(event.currentTarget.getBoundingClientRect());
		}
	};

	const handleMenuHover = (
		index: number,
		event: React.MouseEvent<HTMLButtonElement>,
	) => {
		if (activeMenuIndex !== null && activeMenuIndex !== index) {
			setActiveMenuIndex(index);
			setAnchorRect(event.currentTarget.getBoundingClientRect());
		}
	};

	return (
		<div
			ref={barRef}
			className={`
        w-full px-ui flex items-center justify-between
        min-h-ui py-1
        bg-background/60 backdrop-blur-md border-b border-border shadow-sm
        text-ui font-medium text-foreground
        flex-wrap
        ${className}
      `}
		>
			{/* Identity Section (System + App Menu) - Vertically Centered */}
			<div className="flex items-center gap-1 h-full mr-2 shrink-0">
				{/* System Menu (Apple Logo or Custom) */}
				<button
					type="button"
					className={`
            h-[44px] md:h-full px-3 rounded hover:bg-accent -ml-2 flex items-center gap-2
            ${activeMenuIndex === -1 ? "bg-accent" : ""}
          `}
					onClick={(e) => handleMenuClick(-1, e)}
					onMouseEnter={(e) => handleMenuHover(-1, e)}
				>
					{systemMenu?.icon ? (
						systemMenu.icon
					) : systemMenu?.label ? null : (
						<span className="text-lg">☰</span>
					)}
					{systemMenu?.label && <span>{systemMenu.label}</span>}
				</button>
				{/* System Menu Dropdown */}
				{activeMenuIndex === -1 && (
					<MenuDropdown
						items={
							systemMenu?.items || [
								{
									label: "About This Mac",
									onClick: () => alert("About This Mac"),
								},
								{ separator: true, label: "" },
								{
									label: "System Settings...",
									onClick: () => alert("System Settings"),
								},
								{ label: "App Store...", onClick: () => alert("App Store") },
								{ separator: true, label: "" },
								{
									label: "Recent Items",
									children: [{ label: "None", disabled: true }],
								},
								{ separator: true, label: "" },
								{ label: "Force Quit...", shortcut: "⌥⌘Kc" },
								{ separator: true, label: "" },
								{ label: "Sleep" },
								{ label: "Restart..." },
								{ label: "Shut Down..." },
								{ separator: true, label: "" },
								{ label: "Lock Screen", shortcut: "^⌘Q" },
								{ label: "Log Out User...", shortcut: "⇧⌘Q" },
							]
						}
						isOpen={true}
						onClose={() => setActiveMenuIndex(null)}
						onAction={onAction}
						anchorRect={anchorRect}
					/>
				)}

				{/* App Menu (Bold, like macOS) */}
				{appMenu && (
					<React.Fragment>
						<button
							type="button"
							className={`
                h-[44px] md:h-auto px-3 rounded flex items-center gap-2 font-bold cursor-default
                ${activeMenuIndex === -2 ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground"}
              `}
							onClick={(e) => handleMenuClick(-2, e)}
							onMouseEnter={(e) => handleMenuHover(-2, e)}
						>
							{appMenu.label}
						</button>
						{activeMenuIndex === -2 && (
							<MenuDropdown
								items={appMenu.items}
								isOpen={true}
								onClose={() => setActiveMenuIndex(null)}
								onAction={onAction}
								anchorRect={anchorRect}
							/>
						)}
					</React.Fragment>
				)}
			</div>

			{/* Navigation Section (Menus) - Wraps */}
			<div className="flex flex-wrap items-center gap-1 flex-1">
				{menus.map((menu, index) => (
					<React.Fragment key={menu.label}>
						<button
							type="button"
							className={`
                h-[44px] md:h-[22px] px-3 rounded flex items-center cursor-default
                ${activeMenuIndex === index ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground"}
              `}
							onClick={(e) => handleMenuClick(index, e)}
							onMouseEnter={(e) => handleMenuHover(index, e)}
						>
							{menu.label}
						</button>

						{activeMenuIndex === index && menu.children && (
							<MenuDropdown
								items={menu.children}
								isOpen={true}
								onClose={() => setActiveMenuIndex(null)}
								onAction={onAction}
								anchorRect={anchorRect}
							/>
						)}
					</React.Fragment>
				))}
			</div>

			<div className="flex items-center gap-4 text-xs font-medium opacity-90">
				{/* Right side status items removed as per request */}
			</div>
		</div>
	);
};
