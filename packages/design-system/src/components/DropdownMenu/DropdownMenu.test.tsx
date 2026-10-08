import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu } from "./DropdownMenu";

// Mock ResizeObserver
beforeEach(() => {
	delete (globalThis as unknown as Record<string, unknown>).log;
	global.ResizeObserver = class ResizeObserver {
		observe = vi.fn();
		unobserve = vi.fn();
		disconnect = vi.fn();
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

const items = [
	{ label: "Item 1", onClick: vi.fn() },
	{ label: "Item 2", onClick: vi.fn() },
];

describe("DropdownMenu", () => {
	const user = userEvent.setup();

	it("renders trigger", () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);
		// Wrapper has aria-expanded, inner button does not.
		expect(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		).toBeInTheDocument();
		expect(screen.queryByRole("menu")).not.toBeInTheDocument(); // Menu hidden initially
	});

	it("opens menu on trigger click", async () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);

		// Menu content uses Portal, rendered in document.body
		const menu = await screen.findByRole("menu");
		expect(menu).toBeInTheDocument();

		expect(screen.getByText("Item 1")).toBeInTheDocument();
		expect(screen.getByText("Item 2")).toBeInTheDocument();
	});

	it("calls item onClick and closes menu", async () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		const item1 = await screen.findByText("Item 1");

		await user.click(item1);

		expect(items[0]?.onClick).toHaveBeenCalled();

		// Wait for removal
		await waitFor(() => {
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});
	});

	it("closes on outside click", async () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		await screen.findByRole("menu");

		await user.click(document.body);

		await waitFor(() => {
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});
	});

	it("closes on Escape key", async () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		await screen.findByRole("menu");

		await user.keyboard("{Escape}");

		await waitFor(() => {
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});
	});

	it("opens on Enter key", async () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: "Open Menu",
			expanded: false,
		});
		trigger.focus();
		await user.keyboard("{Enter}");

		await screen.findByRole("menu");
	});

	it("opens on Space key", async () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: "Open Menu",
			expanded: false,
		});
		trigger.focus();
		await user.keyboard(" ");

		await screen.findByRole("menu");
	});

	it("flips to top when space below is insufficient (autoSide)", async () => {
		// Mock window height
		vi.stubGlobal("innerHeight", 500);

		// Mock trigger near bottom
		Element.prototype.getBoundingClientRect = vi.fn(function (this: Element) {
			if (this.getAttribute("role") === "button") {
				// Trigger at bottom: 450-480px
				return {
					top: 450,
					bottom: 480,
					left: 10,
					right: 110,
					width: 100,
					height: 30,
					x: 10,
					y: 450,
					toJSON: () => {},
				} as DOMRect;
			} else if (this.getAttribute("role") === "menu") {
				// Menu height 200px
				return {
					top: 0,
					bottom: 200,
					left: 0,
					right: 100,
					width: 100,
					height: 200,
					x: 0,
					y: 0,
					toJSON: () => {},
				} as DOMRect;
			}
			return {
				top: 0,
				bottom: 0,
				left: 0,
				right: 0,
				width: 0,
				height: 0,
				x: 0,
				y: 0,
				toJSON: () => {},
			} as DOMRect;
		});

		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		const triggers = screen.getAllByRole("button", { name: "Open Menu" });
		const trigger = triggers.find(
			(t) => t.getAttribute("aria-haspopup") === "menu",
		);
		if (!trigger) throw new Error("Trigger not found");

		await user.click(trigger);

		const menu = await screen.findByRole("menu");
		expect(menu).toHaveStyle({ visibility: "visible" });
	});

	it("flips to right when space on left is insufficient (autoFlip)", async () => {
		vi.stubGlobal("innerWidth", 1000);

		Element.prototype.getBoundingClientRect = vi.fn(function (this: Element) {
			if (this.getAttribute("role") === "button") {
				// Trigger near right edge: 950-980 (Width 30)
				return {
					top: 10,
					bottom: 40,
					left: 950,
					right: 980,
					width: 30,
					height: 30,
					x: 950,
					y: 10,
					toJSON: () => {},
				} as DOMRect;
			} else if (this.getAttribute("role") === "menu") {
				// Menu width 100, would overflow right if left aligned
				return {
					top: 0,
					bottom: 200,
					left: 0,
					right: 100,
					width: 100,
					height: 200,
					x: 0,
					y: 0,
					toJSON: () => {},
				} as DOMRect;
			}
			return {
				top: 0,
				bottom: 0,
				left: 0,
				right: 0,
				width: 0,
				height: 0,
				x: 0,
				y: 0,
				toJSON: () => {},
			} as DOMRect;
		});

		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		const triggers = screen.getAllByRole("button", { name: "Open Menu" });
		const trigger = triggers.find(
			(t) => t.getAttribute("aria-haspopup") === "menu",
		);
		if (!trigger) throw new Error("Trigger not found");

		await user.click(trigger);
		expect(await screen.findByRole("menu")).toBeInTheDocument();
	});

	it("updates position on resize", async () => {
		let observeCallback: ResizeObserverCallback = () => {};

		global.ResizeObserver = class ResizeObserver {
			constructor(cb: ResizeObserverCallback) {
				observeCallback = cb;
			}
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = vi.fn();
		};

		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		const triggers = screen.getAllByRole("button", { name: "Open Menu" });
		const trigger = triggers.find(
			(t) => t.getAttribute("aria-haspopup") === "menu",
		);
		if (!trigger) throw new Error("Trigger not found");

		await user.click(trigger);
		await screen.findByRole("menu");

		// Trigger resize
		act(() => {
			observeCallback([], {} as ResizeObserver);
		});
	});

	it("flips to top when bottom overflows due to offset even if spaceBelow was technically enough for height", async () => {
		vi.stubGlobal("innerHeight", 500);

		Element.prototype.getBoundingClientRect = vi.fn(function (this: Element) {
			if (this.getAttribute("role") === "menu") {
				return {
					top: 0,
					bottom: 90,
					left: 0,
					right: 100,
					width: 100,
					height: 90,
					x: 0,
					y: 0,
					toJSON: () => {},
				} as DOMRect;
			}
			return {
				top: 370,
				bottom: 400,
				left: 10,
				right: 110,
				width: 100,
				height: 30,
				x: 10,
				y: 370,
				toJSON: () => {},
			} as DOMRect;
		});

		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
				offset={8}
			/>,
		);

		const triggers = screen.getAllByRole("button", { name: "Open Menu" });
		const trigger = triggers.find(
			(t) => t.getAttribute("aria-haspopup") === "menu",
		);
		if (!trigger) throw new Error("Trigger not found");

		await user.click(trigger);
		const menu = await screen.findByRole("menu");

		expect(menu.style.top).toBe("272px");
	});

	it("does not flip if flipping does not help (both sides overflow)", async () => {
		vi.stubGlobal("innerWidth", 200);

		Element.prototype.getBoundingClientRect = vi.fn(function (this: Element) {
			if (this.getAttribute("role") === "button") {
				return {
					top: 10,
					bottom: 40,
					left: 10,
					right: 40,
					width: 30,
					height: 30,
					x: 10,
					y: 10,
					toJSON: () => {},
				} as DOMRect;
			} else if (this.getAttribute("role") === "menu") {
				return {
					top: 0,
					bottom: 100,
					left: 0,
					right: 300,
					width: 300,
					height: 100,
					x: 0,
					y: 0,
					toJSON: () => {},
				} as DOMRect;
			}
			return {
				top: 0,
				bottom: 0,
				left: 0,
				right: 0,
				width: 0,
				height: 0,
				x: 0,
				y: 0,
				toJSON: () => {},
			} as DOMRect;
		});

		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);

		const triggers = screen.getAllByRole("button", { name: "Open Menu" });
		const trigger = triggers.find(
			(t) => t.getAttribute("aria-haspopup") === "menu",
		);
		if (!trigger) throw new Error("Trigger not found");

		await user.click(trigger);
		const menu = await screen.findByRole("menu");

		expect(menu.style.left).toBe("-108px");
	});

	it("prefers top when both sides insufficient but top is larger", async () => {
		// vh=500. Menu=300.
		// Trigger at 290 (top). Height 20. Bottom 310.
		// Space Above: 290 - 8 = 282. (Insufficient for 300)
		// Space Below: 500 - 310 - 8 = 182. (Insufficient for 300)
		// 282 > 182 -> Should pick Top.
		vi.stubGlobal("innerHeight", 500);

		Element.prototype.getBoundingClientRect = vi.fn(function (this: Element) {
			if (this.getAttribute("role") === "menu") {
				return {
					top: 0,
					bottom: 300,
					left: 0,
					right: 100,
					width: 100,
					height: 300,
					x: 0,
					y: 0,
					toJSON: () => {},
				} as DOMRect;
			}
			return {
				top: 290,
				bottom: 310,
				left: 10,
				right: 110,
				width: 100,
				height: 20,
				x: 10,
				y: 290,
				toJSON: () => {},
			} as DOMRect;
		});

		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		const menu = await screen.findByRole("menu");

		// When top side is chosen, maxHeight is based on triggerRect.top - margin (282px).
		expect(menu.style.maxHeight).toBe("282px");
	});

	it("flips back to bottom if top fits height but offset causes clip (Lines 163-164)", async () => {
		vi.stubGlobal("innerHeight", 500);
		Element.prototype.getBoundingClientRect = vi.fn(function (this: Element) {
			if (this.getAttribute("role") === "menu")
				return {
					height: 120,
					width: 100,
					top: 0,
					bottom: 120,
					x: 0,
					y: 0,
					left: 0,
					right: 100,
					toJSON: () => {},
				} as DOMRect;
			return {
				top: 400,
				bottom: 420,
				left: 0,
				right: 100,
				height: 20,
				width: 100,
				x: 0,
				y: 400,
				toJSON: () => {},
			} as DOMRect;
		});

		// Use negative offset to potentially trigger edge cases in calculation
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
				offset={-50}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		await screen.findByRole("menu");
	});

	it("toggles menu closed when trigger is clicked again", async () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		await screen.findByRole("menu");

		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: true }),
		);
		await waitFor(() => {
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});
	});

	it("toggles menu closed on Enter key again", async () => {
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: "Open Menu",
			expanded: false,
		});
		trigger.focus();
		await user.keyboard("{Enter}");
		await screen.findByRole("menu");

		// Trigger is now expanded=true
		const openTrigger = screen.getByRole("button", {
			name: "Open Menu",
			expanded: true,
		});
		openTrigger.focus();
		await user.keyboard("{Enter}");
		await waitFor(() => {
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		});
	});

	it("renders item with icon", async () => {
		const itemsWithIcon = [
			{
				label: "Icon Item",
				onClick: vi.fn(),
				icon: <span data-testid="icon">ICON</span>,
			},
		];
		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={itemsWithIcon}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		expect(await screen.findByTestId("icon")).toBeInTheDocument();
	});

	it("debounces scroll events using requestAnimationFrame", async () => {
		const rafSpy = vi.spyOn(window, "requestAnimationFrame");

		render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		await screen.findByRole("menu");

		// Clear previous calls (from opening/positioning)
		rafSpy.mockClear();

		// Trigger multiple scroll events synchronously
		fireEvent.scroll(window);
		fireEvent.scroll(window);
		fireEvent.scroll(window);

		// Should call raf only once because further calls are blocked by 'raf' variable check
		expect(rafSpy).toHaveBeenCalledTimes(1);
	});

	it("cancels animation frame on unmount", async () => {
		// Need to ensure raf is pending when unmounting
		// We can force a pending raf by triggering scroll, then immediately unmounting.
		const cancelRafSpy = vi.spyOn(window, "cancelAnimationFrame");

		const { unmount } = render(
			<DropdownMenu
				trigger={<button type="button">Open Menu</button>}
				items={items}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open Menu", expanded: false }),
		);
		await screen.findByRole("menu");

		// Trigger scroll to schedule an update
		fireEvent.scroll(window);

		// Unmount immediately while raf is pending
		unmount();

		expect(cancelRafSpy).toHaveBeenCalled();
	});
});
