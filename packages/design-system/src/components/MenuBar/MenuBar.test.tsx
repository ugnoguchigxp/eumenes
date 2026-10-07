import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuBar } from "./MenuBar";

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}));

// Mock window.alert
const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});

describe("MenuBar", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	const sampleMenus = [
		{
			label: "File",
			children: [
				{ label: "New", action: "new", shortcut: "^N" },
				{ label: "Open", disabled: true },
				{ separator: true, label: "" },
				{
					label: "Recent",
					children: [{ label: "File 1", action: "file1" }],
				},
			],
		},
		{
			label: "Edit",
			children: [{ label: "Cut" }],
		},
	];

	// --- Rendering Tests ---

	it("renders top-level menu items", () => {
		render(<MenuBar menus={sampleMenus} />);
		expect(screen.getByText("File")).toBeDefined();
		expect(screen.getByText("Edit")).toBeDefined();
	});

	it("renders default system menu (hamburger)", () => {
		render(<MenuBar menus={sampleMenus} />);
		expect(screen.getByText("☰")).toBeDefined();
	});

	it("renders custom system menu", () => {
		render(
			<MenuBar
				menus={sampleMenus}
				systemMenu={{
					label: "MySystem",
					icon: <span data-testid="custom-icon">Icon</span>,
					items: [],
				}}
			/>,
		);
		expect(screen.getByText("MySystem")).toBeDefined();
		expect(screen.getByTestId("custom-icon")).toBeDefined();
		expect(screen.queryByText("☰")).toBeNull();
	});

	it("renders custom system menu with only label", () => {
		render(
			<MenuBar
				menus={sampleMenus}
				systemMenu={{
					label: "OnlyLabel",
					items: [],
				}}
			/>,
		);
		expect(screen.getByText("OnlyLabel")).toBeDefined();
		expect(screen.queryByText("☰")).toBeNull();
	});

	it("renders app menu in bold", () => {
		render(
			<MenuBar
				menus={sampleMenus}
				appMenu={{
					label: "MyApp",
					items: [],
				}}
			/>,
		);
		const appMenuBtn = screen.getByText("MyApp");
		expect(appMenuBtn).toBeDefined();
		expect(appMenuBtn).toHaveClass("font-bold");
	});

	// --- Interaction Tests ---

	it("opens dropdown on click", () => {
		render(<MenuBar menus={sampleMenus} />);
		fireEvent.click(screen.getByText("File"));
		expect(screen.getByText("New")).toBeDefined();
		expect(screen.getByText("Open")).toBeDefined();
	});

	it("closes dropdown when clicking the same menu trigger", () => {
		render(<MenuBar menus={sampleMenus} />);
		const fileBtn = screen.getByText("File");
		fireEvent.click(fileBtn);
		expect(screen.getByText("New")).toBeDefined();
		fireEvent.click(fileBtn);
		expect(screen.queryByText("New")).toBeNull();
	});

	it("switches menu on hover when one is already open", () => {
		render(<MenuBar menus={sampleMenus} />);
		// Open File menu
		fireEvent.click(screen.getByText("File"));
		expect(screen.getByText("New")).toBeDefined();

		// Hover Edit menu -> should switch
		fireEvent.mouseEnter(screen.getByText("Edit"));
		expect(screen.queryByText("New")).toBeNull();
		expect(screen.getByText("Cut")).toBeDefined();
	});

	it("does not switch menu on hover if nothing is open", () => {
		render(<MenuBar menus={sampleMenus} />);
		fireEvent.mouseEnter(screen.getByText("File"));
		expect(screen.queryByText("New")).toBeNull();
	});

	it("triggers onAction when item is clicked", () => {
		const onAction = vi.fn();
		render(<MenuBar menus={sampleMenus} onAction={onAction} />);

		fireEvent.click(screen.getByText("File"));
		fireEvent.click(screen.getByText("New"));

		expect(onAction).toHaveBeenCalledWith("new");
	});

	it("triggers local onClick when item is clicked", () => {
		const onClick = vi.fn();
		const menusWithClick = [
			{
				label: "Test",
				children: [{ label: "ClickMe", onClick }],
			},
		];
		render(<MenuBar menus={menusWithClick} />);

		fireEvent.click(screen.getByText("Test"));
		fireEvent.click(screen.getByText("ClickMe"));

		expect(onClick).toHaveBeenCalled();
	});

	it("does not trigger action on disabled items", () => {
		const onAction = vi.fn();
		render(<MenuBar menus={sampleMenus} onAction={onAction} />);

		fireEvent.click(screen.getByText("File"));
		fireEvent.click(screen.getByText("Open"));

		expect(onAction).not.toHaveBeenCalled();
	});

	it("renders shortcuts and separators", () => {
		render(<MenuBar menus={sampleMenus} />);
		fireEvent.click(screen.getByText("File"));
		expect(screen.getByText("^N")).toBeDefined();
	});

	// --- Submenu Tests ---

	it("opens submenu on hover", () => {
		render(<MenuBar menus={sampleMenus} />);
		fireEvent.click(screen.getByText("File"));

		// "Recent" has children
		fireEvent.mouseEnter(screen.getByText("Recent"));
		expect(screen.getByText("File 1")).toBeDefined();
	});

	it("closes submenu when hovering sibling item", () => {
		render(<MenuBar menus={sampleMenus} />);
		fireEvent.click(screen.getByText("File"));

		// Open submenu
		fireEvent.mouseEnter(screen.getByText("Recent"));
		expect(screen.getByText("File 1")).toBeDefined();

		// Hover sibling "New"
		fireEvent.mouseEnter(screen.getByText("New"));
		// Submenu should close (or effectively be replaced/hidden)
		expect(screen.queryByText("File 1")).toBeNull();
	});

	it("does nothing when clicking an item with children (it just keeps it open)", () => {
		const onAction = vi.fn();
		render(<MenuBar menus={sampleMenus} onAction={onAction} />);
		fireEvent.click(screen.getByText("File"));

		// Hover to open submenu first
		fireEvent.mouseEnter(screen.getByText("Recent"));
		expect(screen.getByText("File 1")).toBeDefined();

		// Click "Recent" (which has submenu)
		fireEvent.click(screen.getByText("Recent"));
		expect(onAction).not.toHaveBeenCalled();
		// Should still be open (or re-opened)
		expect(screen.getByText("File 1")).toBeDefined();
	});

	// --- Global Click Outside ---

	it("closes menus when clicking outside", () => {
		render(<MenuBar menus={sampleMenus} />);
		fireEvent.click(screen.getByText("File"));
		expect(screen.getByText("New")).toBeDefined();

		fireEvent.mouseDown(document.body);
		expect(screen.queryByText("New")).toBeNull();
	});

	it("does not close when clicking inside the menu bar", () => {
		render(<MenuBar menus={sampleMenus} />);
		const bar = screen.getByText("File").parentElement?.parentElement; // roughly the bar
		fireEvent.click(screen.getByText("File"));

		if (bar) fireEvent.mouseDown(bar);
		expect(screen.getByText("New")).toBeDefined();
	});

	// --- System Menu Default Actions ---

	it("triggers default system menu actions", () => {
		render(<MenuBar menus={sampleMenus} />);

		// 1. About
		fireEvent.click(screen.getByText("☰"));
		fireEvent.click(screen.getByText("About This Mac"));
		expect(alertMock).toHaveBeenCalledWith("About This Mac");

		// 2. Settings - Re-open menu because previous click closed it
		fireEvent.click(screen.getByText("☰"));
		fireEvent.click(screen.getByText("System Settings..."));
		expect(alertMock).toHaveBeenCalledWith("System Settings");

		// 3. App Store - Re-open menu
		fireEvent.click(screen.getByText("☰"));
		fireEvent.click(screen.getByText("App Store..."));
		expect(alertMock).toHaveBeenCalledWith("App Store");
	});

	// --- App Menu Interactions ---

	it("opens app menu dropdown", () => {
		render(
			<MenuBar
				menus={sampleMenus}
				appMenu={{
					label: "MyApp",
					items: [{ label: "About MyApp" }],
				}}
			/>,
		);
		fireEvent.click(screen.getByText("MyApp"));
		expect(screen.getByText("About MyApp")).toBeDefined();
	});

	// --- UI Utility Classes ---

	it("applies generic UI utility classes", () => {
		const { container } = render(<MenuBar menus={sampleMenus} />);
		const bar = container.firstChild as HTMLElement;
		expect(bar?.classList.contains("px-ui")).toBe(true);
		expect(bar?.classList.contains("min-h-ui")).toBe(true);
		expect(bar?.classList.contains("text-ui")).toBe(true);
	});
});
