import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DropdownMenu } from "./DropdownMenu";

beforeEach(() => {
	vi.stubGlobal("innerWidth", 1000);
	vi.stubGlobal("innerHeight", 600);
	vi.stubGlobal("visualViewport", undefined);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
		function (this: Element) {
			if (this.getAttribute("role") === "menu") {
				// Like the browser, measurement in one column is independent of the final two-column box.
				return {
					width: 240,
					height: this.querySelectorAll('[role="menuitem"]').length * 40 + 16,
				} as DOMRect;
			}
			if (this.getAttribute("role") === "menuitem")
				return { height: 40 } as DOMRect;
			return {
				top: 8,
				bottom: 44,
				left: 900,
				right: 936,
				width: 36,
				height: 36,
			} as DOMRect;
		},
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("reflows between one and two columns on resize, preserves focus, and navigates across columns", async () => {
	const user = userEvent.setup();
	const select = vi.fn();
	const items = Array.from({ length: 17 }, (_, i) => ({
		label: `Entry ${i + 1}`,
		onClick: () => select(i),
	}));
	const { rerender } = render(
		<DropdownMenu
			trigger={<button>Open</button>}
			items={items}
			minWidthPx={240}
		/>,
	);
	await user.click(screen.getByText("Open"));
	const menu = await screen.findByRole("menu");
	const buttons = screen.getAllByRole("menuitem");
	await waitFor(() => expect(menu.style.width).toBe("480px"));
	await waitFor(() => expect(buttons[0]).toHaveFocus());
	await user.keyboard("{ArrowRight}");
	expect(buttons[13]).toHaveFocus();
	await user.keyboard("{ArrowLeft}{ArrowDown}");
	expect(buttons[1]).toHaveFocus();
	act(() => {
		vi.stubGlobal("innerWidth", 390);
		window.dispatchEvent(new Event("resize"));
	});
	await waitFor(() => expect(menu.style.width).toBe("240px"));
	expect(buttons[1]).toHaveFocus();
	act(() => {
		vi.stubGlobal("innerWidth", 1000);
		window.dispatchEvent(new Event("resize"));
	});
	await waitFor(() => expect(menu.style.width).toBe("480px"));
	rerender(
		<DropdownMenu
			trigger={<button>Open</button>}
			items={[...items]}
			minWidthPx={240}
		/>,
	);
	expect(buttons[1]).toHaveFocus();
	await user.keyboard("{End}{Enter}");
	expect(select).toHaveBeenCalledExactlyOnceWith(16);
	expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	expect(screen.getByText("Open")).toHaveFocus();
});

it("recalculates the layout when entries are added to an open menu", async () => {
	const user = userEvent.setup();
	const items = Array.from({ length: 17 }, (_, i) => ({
		label: `Entry ${i + 1}`,
		onClick: vi.fn(),
	}));
	const { rerender } = render(
		<DropdownMenu
			trigger={<button>Open</button>}
			items={items.slice(0, 3)}
			minWidthPx={240}
		/>,
	);
	await user.click(screen.getByText("Open"));
	const menu = await screen.findByRole("menu");
	await waitFor(() => expect(menu.style.width).toBe("240px"));
	rerender(
		<DropdownMenu
			trigger={<button>Open</button>}
			items={items}
			minWidthPx={240}
		/>,
	);
	await waitFor(() => expect(menu.style.width).toBe("480px"));
	expect(screen.getAllByRole("menuitem")).toHaveLength(17);
});
