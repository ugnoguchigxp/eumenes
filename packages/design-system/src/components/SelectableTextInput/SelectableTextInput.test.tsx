import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectableTextInput } from "./SelectableTextInput";

describe("SelectableTextInput Component", () => {
	const mockOnChange = vi.fn();
	const options = [
		{ label: "Option 1", value: "opt1" },
		{ label: "Option 2", value: "opt2" },
	];

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders select with options and input", () => {
		render(
			<SelectableTextInput
				options={options}
				value="opt1"
				onChange={mockOnChange}
				placeholder="Enter text"
			/>,
		);

		// Check Select
		const select = screen.getByRole("combobox");
		expect(select).toBeInTheDocument();
		expect(select).toHaveValue("opt1");
		expect(screen.getByText("Option 1")).toBeInTheDocument();
		expect(screen.getByText("Option 2")).toBeInTheDocument();

		// Check Input
		const input = screen.getByRole("textbox");
		expect(input).toBeInTheDocument();
		expect(input).toHaveAttribute("placeholder", "Enter text");
	});

	it("calls onChange when select value changes", () => {
		render(
			<SelectableTextInput
				options={options}
				value="opt1"
				onChange={mockOnChange}
			/>,
		);

		const select = screen.getByRole("combobox");
		fireEvent.change(select, { target: { value: "opt2" } });

		expect(mockOnChange).toHaveBeenCalledWith("opt2");
	});

	it("renders with custom className", () => {
		const { container } = render(
			<SelectableTextInput options={options} className="custom-class" />,
		);

		expect(container.firstChild).toHaveClass("custom-class");
	});
});
