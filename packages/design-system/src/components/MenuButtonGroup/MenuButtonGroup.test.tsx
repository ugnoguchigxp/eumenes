import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ButtonGroupItem,
	calculateLastRowInfo,
	calculateOptimalColumnCount,
	MenuButtonGroup,
} from "./MenuButtonGroup";

describe("MenuButtonGroup", () => {
	const mockOnAction = vi.fn();
	const items: ButtonGroupItem[] = [
		{ label: "Item 1", action: "item1" },
		{ label: "Item 2", action: "item2" },
		{ separator: true, label: "" },
		{ label: "Item 3", action: "item3", disabled: true },
	];

	beforeEach(() => {
		mockOnAction.mockClear();
	});

	const getVisibleButton = (text: string): HTMLElement => {
		const buttons = screen.getAllByText(text);
		return (buttons.find(
			(btn) => !btn.closest('[data-testid="measure-container"]'),
		) ?? buttons[0]) as HTMLElement;
	};

	it("renders all items correctly", () => {
		render(<MenuButtonGroup items={items} />);
		expect(getVisibleButton("Item 1")).toBeDefined();
		expect(getVisibleButton("Item 2")).toBeDefined();
		expect(getVisibleButton("Item 3")).toBeDefined();
	});

	it("calls onAction when an item is clicked", () => {
		render(<MenuButtonGroup items={items} onAction={mockOnAction} />);
		fireEvent.click(getVisibleButton("Item 1"));
		expect(mockOnAction).toHaveBeenCalledWith("item1");
	});

	it("does not call onAction when a disabled item is clicked", () => {
		render(<MenuButtonGroup items={items} onAction={mockOnAction} />);
		fireEvent.click(getVisibleButton("Item 3"));
		expect(mockOnAction).not.toHaveBeenCalled();
	});

	it("does not render separators", () => {
		const { container } = render(<MenuButtonGroup items={items} />);
		expect(container.querySelectorAll(".bg-border.w-px").length).toBe(0);
	});

	it("highlights the selected item", () => {
		render(<MenuButtonGroup items={items} selectedId="item2" />);
		const button2 = getVisibleButton("Item 2").closest("button");
		expect(button2?.className).toContain("bg-accent");
	});

	it("calls item onClick handler when clicked", () => {
		const mockItemClick = vi.fn();
		render(
			<MenuButtonGroup
				items={[
					{ label: "Clickable", action: "click1", onClick: mockItemClick },
				]}
			/>,
		);
		fireEvent.click(getVisibleButton("Clickable"));
		expect(mockItemClick).toHaveBeenCalled();
	});

	it("truncates long labels to 16 characters", () => {
		render(
			<MenuButtonGroup
				items={[
					{
						label: "This is a very long label that exceeds sixteen characters",
						action: "long",
					},
				]}
			/>,
		);
		expect(getVisibleButton("This is a very l")).toBeDefined();
	});

	it("renders with empty items array", () => {
		const { container } = render(<MenuButtonGroup items={[]} />);
		expect(container.querySelector(".grid")).toBeDefined();
	});

	it("renders items with icons", () => {
		render(
			<MenuButtonGroup
				items={[
					{
						label: "With Icon",
						action: "icon1",
						icon: <span data-testid="icon">🔥</span>,
					},
				]}
			/>,
		);
		expect(screen.getAllByTestId("icon").length).toBeGreaterThan(0);
	});

	it("applies custom className", () => {
		const { container } = render(
			<MenuButtonGroup items={items} className="custom-class" />,
		);
		expect(container.querySelector(".custom-class")).toBeDefined();
	});

	it("handles items without action", () => {
		render(
			<MenuButtonGroup
				items={[{ label: "No Action" }]}
				onAction={mockOnAction}
			/>,
		);
		fireEvent.click(getVisibleButton("No Action"));
		expect(mockOnAction).not.toHaveBeenCalled();
	});

	it("handles null selectedId", () => {
		render(<MenuButtonGroup items={items} selectedId={null} />);
		const button1 = getVisibleButton("Item 1").closest("button");
		expect(button1?.className).not.toContain("bg-accent");
	});

	it("handles undefined items gracefully", () => {
		// @ts-expect-error Testing undefined items
		const { container } = render(<MenuButtonGroup items={undefined} />);
		expect(container.querySelector(".grid")).toBeDefined();
	});

	it("calls both onClick and onAction", () => {
		const mockItemClick = vi.fn();
		render(
			<MenuButtonGroup
				items={[{ label: "Both", action: "both", onClick: mockItemClick }]}
				onAction={mockOnAction}
			/>,
		);
		fireEvent.click(getVisibleButton("Both"));
		expect(mockItemClick).toHaveBeenCalled();
		expect(mockOnAction).toHaveBeenCalledWith("both");
	});

	// Tests using _testColumnCount to test stretchLastRow
	describe("with stretchLastRow and _testColumnCount", () => {
		const fiveItems: ButtonGroupItem[] = [
			{ label: "A", action: "a" },
			{ label: "B", action: "b" },
			{ label: "C", action: "c" },
			{ label: "D", action: "d" },
			{ label: "E", action: "e" },
		];

		it("renders last row items with stretchLastRow=true", () => {
			// 5 items, 3 cols => 2 rows: [A,B,C], [D,E]
			// lastRowItems = [D, E]
			render(
				<MenuButtonGroup
					items={fiveItems}
					stretchLastRow={true}
					_testColumnCount={3}
				/>,
			);
			expect(screen.getByText("A")).toBeDefined();
			expect(screen.getByText("D")).toBeDefined();
			expect(screen.getByText("E")).toBeDefined();
		});

		it("applies grid column span to last row items", () => {
			const { container } = render(
				<MenuButtonGroup
					items={fiveItems}
					stretchLastRow={true}
					_testColumnCount={3}
				/>,
			);
			// Last row items should have style with gridColumn
			const buttons = container.querySelectorAll("button");
			const lastButton = buttons[buttons.length - 1];
			expect(lastButton?.style.gridColumn).toContain("span");
		});

		it("highlights selected item in last row", () => {
			render(
				<MenuButtonGroup
					items={fiveItems}
					stretchLastRow={true}
					selectedId="e"
					_testColumnCount={3}
				/>,
			);
			const buttonE = screen.getByText("E").closest("button");
			expect(buttonE?.className).toContain("bg-accent");
		});

		it("handles click on last row item", () => {
			render(
				<MenuButtonGroup
					items={fiveItems}
					stretchLastRow={true}
					onAction={mockOnAction}
					_testColumnCount={3}
				/>,
			);
			fireEvent.click(screen.getByText("E"));
			expect(mockOnAction).toHaveBeenCalledWith("e");
		});

		it("does not stretch when last row is full", () => {
			// 6 items, 3 cols => 2 full rows
			const sixItems = [...fiveItems, { label: "F", action: "f" }];
			const { container } = render(
				<MenuButtonGroup
					items={sixItems}
					stretchLastRow={true}
					_testColumnCount={3}
				/>,
			);
			const buttons = container.querySelectorAll("button");
			// All buttons should be in mainItems, none with gridColumn span
			const lastButton = buttons[buttons.length - 1];
			expect(lastButton?.style.gridColumn).toBe("");
		});

		it("truncates long labels in last row", () => {
			const longItems: ButtonGroupItem[] = [
				{ label: "A", action: "a" },
				{ label: "B", action: "b" },
				{ label: "C", action: "c" },
				{
					label: "This label is way too long for display",
					action: "long",
				},
			];
			render(
				<MenuButtonGroup
					items={longItems}
					stretchLastRow={true}
					_testColumnCount={3}
				/>,
			);
			expect(screen.getByText("This label is wa")).toBeDefined();
		});

		it("renders disabled last row item correctly", () => {
			const itemsWithDisabled: ButtonGroupItem[] = [
				{ label: "A", action: "a" },
				{ label: "B", action: "b" },
				{ label: "C", action: "c" },
				{ label: "D", action: "d", disabled: true },
			];
			render(
				<MenuButtonGroup
					items={itemsWithDisabled}
					stretchLastRow={true}
					onAction={mockOnAction}
					_testColumnCount={3}
				/>,
			);
			const buttonD = screen.getByText("D").closest("button");
			expect(buttonD?.disabled).toBe(true);
			fireEvent.click(screen.getByText("D"));
			expect(mockOnAction).not.toHaveBeenCalled();
		});

		it("renders icon in last row item", () => {
			const itemsWithIcon: ButtonGroupItem[] = [
				{ label: "A", action: "a" },
				{ label: "B", action: "b" },
				{ label: "C", action: "c" },
				{
					label: "D",
					action: "d",
					icon: <span data-testid="last-icon">⭐</span>,
				},
			];
			render(
				<MenuButtonGroup
					items={itemsWithIcon}
					stretchLastRow={true}
					_testColumnCount={3}
				/>,
			);
			expect(screen.getByTestId("last-icon")).toBeDefined();
		});
	});
});

describe("calculateOptimalColumnCount", () => {
	it("returns item count when all fit in one row", () => {
		expect(calculateOptimalColumnCount([100, 100, 100], 400)).toBe(3);
	});

	it("reduces columns when width is too narrow", () => {
		expect(calculateOptimalColumnCount([100, 100, 100, 100], 250)).toBe(2);
	});

	it("returns 1 when very narrow", () => {
		expect(calculateOptimalColumnCount([100, 100, 100], 50)).toBe(1);
	});

	it("handles empty array", () => {
		expect(calculateOptimalColumnCount([], 500)).toBe(1);
	});

	it("handles zero container width", () => {
		expect(calculateOptimalColumnCount([100, 100], 0)).toBe(2);
	});

	it("handles variable widths", () => {
		expect(calculateOptimalColumnCount([50, 200, 50, 200], 300)).toBe(2);
	});

	it("calculates with uneven distribution", () => {
		expect(calculateOptimalColumnCount([100, 100, 100, 100, 100], 350)).toBe(3);
	});
});

describe("calculateLastRowInfo", () => {
	it("returns correct info for full last row", () => {
		const result = calculateLastRowInfo(6, 3);
		expect(result.lastRowStartIndex).toBe(6);
		expect(result.isLastRowFull).toBe(true);
	});

	it("returns correct info for partial last row", () => {
		const result = calculateLastRowInfo(5, 3);
		expect(result.lastRowStartIndex).toBe(3);
		expect(result.lastRowItemCount).toBe(2);
		expect(result.isLastRowFull).toBe(false);
	});

	it("handles columnCount of 0", () => {
		const result = calculateLastRowInfo(5, 0);
		expect(result.isLastRowFull).toBe(true);
	});

	it("handles single item", () => {
		const result = calculateLastRowInfo(1, 3);
		expect(result.isLastRowFull).toBe(false);
	});

	it("handles exact multiple", () => {
		const result = calculateLastRowInfo(9, 3);
		expect(result.isLastRowFull).toBe(true);
	});
});
