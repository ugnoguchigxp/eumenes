import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditableSelect } from "./EditableSelect";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

// Mock Lucide icons
vi.mock("lucide-react", () => ({
	ChevronDown: () => <div data-testid="icon-chevron-down" />,
}));

// Mock selectVariants
vi.mock("../../../src/components/Select/selectVariants", () => ({
	selectTriggerVariants: vi.fn(() => "mock-trigger-variant"),
	selectItemVariants: vi.fn(() => "mock-item-variant"),
}));

describe("EditableSelect Component", () => {
	const mockOnChange = vi.fn();
	const options = ["Option 1", "Option 2", "Option 3"];

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Rendering", () => {
		it("renders with initial value", () => {
			render(
				<EditableSelect
					value="Initial Value"
					onChange={mockOnChange}
					options={options}
				/>,
			);

			const input = screen.getByRole("textbox");
			expect(input).toHaveValue("Initial Value");
			expect(screen.getByTestId("icon-chevron-down")).toBeInTheDocument();
		});

		it("renders placeholder when value is empty", () => {
			render(
				<EditableSelect
					value=""
					onChange={mockOnChange}
					options={options}
					placeholder="Enter text..."
				/>,
			);

			const input = screen.getByRole("textbox");
			expect(input).toHaveAttribute("placeholder", "Enter text...");
		});

		it("renders in disabled state", () => {
			render(
				<EditableSelect
					value="Value"
					onChange={mockOnChange}
					options={options}
					disabled
				/>,
			);

			const input = screen.getByRole("textbox");
			expect(input).toBeDisabled();
			const container = input.closest("div");
			expect(container).toHaveAttribute("aria-disabled", "true");
		});
	});

	describe("Interaction", () => {
		it("calls onChange when input value changes", () => {
			render(
				<EditableSelect value="" onChange={mockOnChange} options={options} />,
			);

			const input = screen.getByRole("textbox");
			fireEvent.change(input, { target: { value: "New Value" } });

			expect(mockOnChange).toHaveBeenCalledWith("New Value");
		});

		it("opens dropdown options when toggle button is clicked", () => {
			render(
				<EditableSelect value="" onChange={mockOnChange} options={options} />,
			);

			const toggleButton = screen.getByLabelText("Toggle options");
			fireEvent.click(toggleButton);

			options.forEach((option) => {
				expect(screen.getByText(option)).toBeInTheDocument();
			});
		});

		it("opens dropdown options when input is focused", () => {
			render(
				<EditableSelect value="" onChange={mockOnChange} options={options} />,
			);

			const input = screen.getByRole("textbox");
			fireEvent.focus(input);

			options.forEach((option) => {
				expect(screen.getByText(option)).toBeInTheDocument();
			});
		});

		it("calls onChange and closes dropdown when option is selected", () => {
			render(
				<EditableSelect value="" onChange={mockOnChange} options={options} />,
			);

			// Open dropdown
			const toggleButton = screen.getByLabelText("Toggle options");
			fireEvent.click(toggleButton);

			// select option
			const optionToSelect = screen.getByText("Option 2");
			fireEvent.click(optionToSelect);

			expect(mockOnChange).toHaveBeenCalledWith("Option 2");
			expect(screen.queryByText("Option 1")).not.toBeInTheDocument(); // Dropdown should be closed
		});

		it("closes dropdown when clicking outside", () => {
			render(
				<div data-testid="outside">
					<EditableSelect value="" onChange={mockOnChange} options={options} />
				</div>,
			);

			// Open dropdown
			const toggleButton = screen.getByLabelText("Toggle options");
			fireEvent.click(toggleButton);
			expect(screen.getByText("Option 1")).toBeInTheDocument();

			// Click outside
			fireEvent.mouseDown(screen.getByTestId("outside"));
			expect(screen.queryByText("Option 1")).not.toBeInTheDocument();
		});
	});
});
