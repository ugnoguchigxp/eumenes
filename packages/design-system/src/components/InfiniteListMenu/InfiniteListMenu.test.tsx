import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	InfiniteListMenu,
	type InfiniteListMenuItem,
} from "@/components/InfiniteListMenu/InfiniteListMenu";

const items: InfiniteListMenuItem[] = [
	{ id: "1", label: "患者 001", description: "病棟 1 / 30歳" },
	{ id: "2", label: "患者 002", description: "病棟 2 / 40歳" },
	{ id: "3", label: "患者 003", description: "病棟 3 / 50歳" },
];

describe("InfiniteListMenu", () => {
	it("renders empty state", () => {
		render(<InfiniteListMenu items={[]} emptyText="空です" />);
		expect(screen.getByText("空です")).toBeInTheDocument();
	});

	it("renders selected state based on selectedId", () => {
		render(<InfiniteListMenu items={items} selectedId="2" />);
		const selectedItem = screen.getByText("患者 002").closest("button");
		expect(selectedItem).toHaveAttribute("aria-selected", "true");
	});

	it("renders selected state based on selectedItem object", () => {
		render(<InfiniteListMenu items={items} selectedItem={items[1]} />);
		const selectedItem = screen.getByText("患者 002").closest("button");
		expect(selectedItem).toHaveAttribute("aria-selected", "true");
	});

	it("prioritizes selectedItem over selectedId", () => {
		// selectedId points to item 2, but selectedItem points to item 1.
		// Item 1 should be selected.
		render(
			<InfiniteListMenu items={items} selectedId="2" selectedItem={items[0]} />,
		);
		const item1 = screen.getByText("患者 001").closest("button");
		const item2 = screen.getByText("患者 002").closest("button");

		expect(item1).toHaveAttribute("aria-selected", "true");
		expect(item2).toHaveAttribute("aria-selected", "false");
	});

	it("selects item on click and returns object", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<InfiniteListMenu items={items} onSelect={onSelect} />);
		await user.click(screen.getByText("患者 002"));
		expect(onSelect).toHaveBeenCalledWith(
			"2",
			expect.objectContaining({ id: "2", label: "患者 002" }),
		);
	});

	it("calls onLoadMore when scrolled near bottom", () => {
		const onLoadMore = vi.fn();
		render(
			<InfiniteListMenu
				items={items}
				onLoadMore={onLoadMore}
				hasMore
				isLoading={false}
			/>,
		);

		const scrollContainer = screen.getByTestId("infinite-list-menu-scroll");

		Object.defineProperty(scrollContainer, "scrollHeight", { value: 1000 });
		Object.defineProperty(scrollContainer, "clientHeight", { value: 200 });
		Object.defineProperty(scrollContainer, "scrollTop", { value: 820 });

		fireEvent.scroll(scrollContainer);

		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it("renders with controlled width", () => {
		render(<InfiniteListMenu items={items} width={300} />);
		const scrollContainer = screen.getByTestId("infinite-list-menu-scroll");
		const root = scrollContainer.parentElement;
		expect(root).toHaveStyle({ width: "300px" });
	});

	it("calls onResize when resized in controlled mode", () => {
		const onResize = vi.fn();
		render(
			<InfiniteListMenu
				items={items}
				width={200}
				resizable
				onResize={onResize}
			/>,
		);

		const handle = screen.getByTestId("infinite-list-menu-resize-handle");
		const scrollContainer = screen.getByTestId("infinite-list-menu-scroll");
		const root = scrollContainer.parentElement;

		if (!root) throw new Error("Root element not found");

		// Mock getBoundingClientRect
		vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
			width: 200,
			left: 0,
			right: 200,
			top: 0,
			bottom: 500,
			height: 500,
			x: 0,
			y: 0,
			toJSON: () => {},
		});

		fireEvent.mouseDown(handle, { clientX: 200 });
		fireEvent.mouseMove(document, { clientX: 250 });
		fireEvent.mouseUp(document);

		// Delta is 50, so new width should be 250
		expect(onResize).toHaveBeenCalledWith(250);
	});

	it("resizes internally in uncontrolled mode", () => {
		render(<InfiniteListMenu items={items} resizable />);

		const handle = screen.getByTestId("infinite-list-menu-resize-handle");
		const scrollContainer = screen.getByTestId("infinite-list-menu-scroll");
		const root = scrollContainer.parentElement;

		if (!root) throw new Error("Root element not found");

		vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
			width: 200,
			left: 0,
			right: 200,
			top: 0,
			bottom: 500,
			height: 500,
			x: 0,
			y: 0,
			toJSON: () => {},
		});

		fireEvent.mouseDown(handle, { clientX: 200 });
		fireEvent.mouseMove(document, { clientX: 300 });
		fireEvent.mouseUp(document);

		// Delta is 100, so new width should be 300
		expect(root).toHaveStyle({ width: "300px" });
	});
});
