import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScaleInput } from "./ScaleInput";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

describe("ScaleInput Component", () => {
	const mockOnChange = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Rendering", () => {
		it("renders with default range 0-10", () => {
			render(<ScaleInput onChange={mockOnChange} />);

			const buttons = screen.getAllByRole("button");
			expect(buttons).toHaveLength(11); // 0 to 10 is 11 numbers
			expect(screen.getByText("0")).toBeInTheDocument();
			expect(screen.getByText("10")).toBeInTheDocument();
		});

		it("renders custom range", () => {
			render(<ScaleInput onChange={mockOnChange} min={1} max={5} />);

			const buttons = screen.getAllByRole("button");
			expect(buttons).toHaveLength(5);
			expect(screen.getByText("1")).toBeInTheDocument();
			expect(screen.getByText("5")).toBeInTheDocument();
		});

		it("renders label", () => {
			render(<ScaleInput onChange={mockOnChange} label="Pain Scale" />);

			expect(screen.getByText("Pain Scale")).toBeInTheDocument();
		});

		it("renders min and max labels", () => {
			render(
				<ScaleInput
					onChange={mockOnChange}
					minLabel="No Pain"
					maxLabel="Worst Pain"
				/>,
			);

			expect(screen.getByText("No Pain")).toBeInTheDocument();
			expect(screen.getByText("Worst Pain")).toBeInTheDocument();
		});

		it("renders disabled state", () => {
			render(<ScaleInput onChange={mockOnChange} disabled />);

			const buttons = screen.getAllByRole("button");
			buttons.forEach((button) => {
				expect(button).toBeDisabled();
				expect(button).toHaveClass("opacity-50", "cursor-not-allowed");
			});
		});
	});

	describe("Interaction", () => {
		it("calls onChange when a number is clicked", () => {
			render(<ScaleInput onChange={mockOnChange} />);

			fireEvent.click(screen.getByText("5"));
			expect(mockOnChange).toHaveBeenCalledWith(5);
		});

		it("does not call onChange when disabled", () => {
			render(<ScaleInput onChange={mockOnChange} disabled />);

			fireEvent.click(screen.getByText("5"));
			expect(mockOnChange).not.toHaveBeenCalled();
		});
	});

	describe("Styling", () => {
		it("applies active styles to selected value", () => {
			render(<ScaleInput onChange={mockOnChange} value={5} />);

			const selectedButton = screen.getByRole("button", { name: "5" });
			expect(selectedButton).toHaveClass(
				"bg-primary",
				"text-primary-foreground",
				"scale-110",
			);

			const unselectedButton = screen.getByRole("button", { name: "4" });
			expect(unselectedButton).toHaveClass("bg-card", "text-muted-foreground");
		});
	});
});
