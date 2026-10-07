import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ViewSwitcher } from "./ViewSwitcher";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

// Mock Tooltip components
vi.mock("@/components/Tooltip/Tooltip", () => ({
	TooltipProvider: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	Tooltip: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	TooltipTrigger: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	TooltipContent: ({ children }: { children?: React.ReactNode }) => (
		<div data-testid="tooltip-content">{children}</div>
	),
}));

describe("ViewSwitcher Component", () => {
	const mockOnChange = vi.fn();
	const options = [
		{
			value: "grid",
			icon: () => <span data-testid="icon-grid" />,
			tooltip: "Grid View",
		},
		{
			value: "list",
			icon: () => <span data-testid="icon-list" />,
			tooltip: "List View",
		},
	];

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders options with icons", () => {
		render(
			<ViewSwitcher options={options} value="grid" onChange={mockOnChange} />,
		);

		expect(screen.getByTestId("icon-grid")).toBeInTheDocument();
		expect(screen.getByTestId("icon-list")).toBeInTheDocument();
	});

	it("calls onChange when clicking an option", () => {
		render(
			<ViewSwitcher options={options} value="grid" onChange={mockOnChange} />,
		);

		const listBtn = screen.getByLabelText("List View");
		fireEvent.click(listBtn);
		expect(mockOnChange).toHaveBeenCalledWith("list");
	});

	it("renders active styling for selected value", () => {
		render(
			<ViewSwitcher options={options} value="grid" onChange={mockOnChange} />,
		);

		const gridBtn = screen.getByLabelText("Grid View");
		expect(gridBtn).toHaveClass("bg-accent", "text-white");

		const listBtn = screen.getByLabelText("List View");
		expect(listBtn).toHaveClass("text-muted-foreground");
	});

	it("renders tooltips", () => {
		render(
			<ViewSwitcher options={options} value="grid" onChange={mockOnChange} />,
		);

		expect(screen.getByText("Grid View")).toBeInTheDocument();
		expect(screen.getByText("List View")).toBeInTheDocument();
	});
});
