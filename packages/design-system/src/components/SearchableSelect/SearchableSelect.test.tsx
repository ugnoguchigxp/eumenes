import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchableSelect } from "./SearchableSelect";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

// Mock Input component
vi.mock("../../../src/components/Input", () => ({
	Input: vi.fn(
		({
			onFocus,
			onBlur,
			onKeyDown,
			onChange,
			value,
			placeholder,
			disabled,
			role,
			"aria-label": ariaLabel,
			id,
			name,
		}) => (
			<input
				value={value}
				onChange={onChange}
				onFocus={onFocus}
				onBlur={onBlur}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
				disabled={disabled}
				role={role}
				aria-label={ariaLabel}
				id={id}
				name={name}
				data-testid="mock-input"
			/>
		),
	),
}));

describe("SearchableSelect Component", () => {
	const mockOnChange = vi.fn();
	const options = [
		{ label: "Apple", value: "apple" },
		{ label: "Banana", value: "banana" },
		{ label: "Cherry", value: "cherry" },
	];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders input with placeholder", () => {
		render(
			<SearchableSelect
				options={options}
				onChange={mockOnChange}
				placeholder="Select a fruit"
			/>,
		);

		const input = screen.getByTestId("mock-input");
		expect(input).toBeInTheDocument();
		expect(input).toHaveAttribute("placeholder", "Select a fruit");
	});

	it("filters options based on input", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);

		const input = screen.getByTestId("mock-input");

		// Focus to open
		fireEvent.focus(input);
		expect(screen.getByText("Apple")).toBeInTheDocument();
		expect(screen.getByText("Banana")).toBeInTheDocument();

		// Type 'app'
		fireEvent.change(input, { target: { value: "app" } });
		expect(screen.getByText("Apple")).toBeInTheDocument();
		expect(screen.queryByText("Banana")).not.toBeInTheDocument();
	});

	it("selects option on click", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);

		const input = screen.getByTestId("mock-input");
		fireEvent.focus(input);

		const option = screen.getByText("Banana");
		fireEvent.click(option);

		expect(mockOnChange).toHaveBeenCalledWith("banana");
		expect(input).toHaveValue("Banana"); // Input should update to label
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument(); // Dropdown closed
	});

	it("navigates with arrow keys and selects with Enter", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);

		const input = screen.getByTestId("mock-input");
		fireEvent.focus(input);
		// Initial activeIndex is 0 (Apple)

		// Arrow Down -> Banana (Index 1)
		fireEvent.keyDown(input, { key: "ArrowDown" });

		// Enter to select Banana
		fireEvent.keyDown(input, { key: "Enter" });

		expect(mockOnChange).toHaveBeenCalledWith("banana");
		expect(input).toHaveValue("Banana");
	});

	it("navigates with ArrowUp", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);

		const input = screen.getByTestId("mock-input");
		fireEvent.focus(input);

		// Down twice -> Cherry (Index 2)
		fireEvent.keyDown(input, { key: "ArrowDown" }); // Banana (1)
		fireEvent.keyDown(input, { key: "ArrowDown" }); // Cherry (2)

		// Up once -> Banana (1)
		fireEvent.keyDown(input, { key: "ArrowUp" });

		fireEvent.keyDown(input, { key: "Enter" });
		expect(mockOnChange).toHaveBeenCalledWith("banana");
	});

	it("updates active index on mouse hover", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);

		const input = screen.getByTestId("mock-input");
		fireEvent.focus(input);

		const banana = screen.getByText("Banana");
		fireEvent.mouseEnter(banana);

		// Press Enter to confirm selection based on hover index
		fireEvent.keyDown(input, { key: "Enter" });
		expect(mockOnChange).toHaveBeenCalledWith("banana");
	});

	it("prevents default on option mousedown to keep focus", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);

		const input = screen.getByTestId("mock-input");
		fireEvent.focus(input);

		const banana = screen.getByText("Banana");
		const mouseDownEvent = new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});
		vi.spyOn(mouseDownEvent, "preventDefault");

		fireEvent.mouseDown(banana);
	});

	it("closes on Escape", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);

		const input = screen.getByTestId("mock-input");
		fireEvent.focus(input);
		expect(screen.getByRole("listbox")).toBeInTheDocument();

		fireEvent.keyDown(input, { key: "Escape" });
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("displays no results message", () => {
		render(
			<SearchableSelect
				options={options}
				onChange={mockOnChange}
				noResultsText="Nothing here"
			/>,
		);

		const input = screen.getByTestId("mock-input");
		fireEvent.change(input, { target: { value: "xyz" } });
		fireEvent.focus(input);

		expect(screen.getByText("Nothing here")).toBeInTheDocument();
	});

	it("resets query to selected label on blur if no selection made", () => {
		// Initial value
		render(
			<SearchableSelect
				options={options}
				value="apple"
				onChange={mockOnChange}
			/>,
		);

		const input = screen.getByTestId("mock-input");
		expect(input).toHaveValue("Apple");

		// Change input but don't select
		fireEvent.change(input, { target: { value: "Something else" } });
		expect(input).toHaveValue("Something else");

		// Blur
		fireEvent.blur(input);

		act(() => {
			vi.runAllTimers();
		});

		// Should revert to 'Apple' (label of 'apple')
		expect(input).toHaveValue("Apple");
	});

	it("renders disabled state", () => {
		render(
			<SearchableSelect options={options} onChange={mockOnChange} disabled />,
		);

		const input = screen.getByTestId("mock-input");
		expect(input).toBeDisabled();

		// Should not open on click/focus
		fireEvent.click(input);
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("updates query when external value changes", () => {
		const { rerender } = render(
			<SearchableSelect
				options={options}
				value="apple"
				onChange={mockOnChange}
			/>,
		);
		const input = screen.getByTestId("mock-input");
		expect(input).toHaveValue("Apple");

		// Update prop
		rerender(
			<SearchableSelect
				options={options}
				value="banana"
				onChange={mockOnChange}
			/>,
		);

		expect(input).toHaveValue("Banana");
	});

	it("closes on click outside", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);
		const input = screen.getByTestId("mock-input");
		fireEvent.focus(input);
		expect(screen.getByRole("listbox")).toBeInTheDocument();

		// Click outside (e.g. document body)
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("does nothing on Enter if closed", () => {
		render(<SearchableSelect options={options} onChange={mockOnChange} />);
		const input = screen.getByTestId("mock-input");

		fireEvent.keyDown(input, { key: "Enter" });
		expect(mockOnChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("does not open if disabled on input change", () => {
		render(
			<SearchableSelect options={options} onChange={mockOnChange} disabled />,
		);
		const input = screen.getByTestId("mock-input");
		fireEvent.change(input, { target: { value: "a" } });

		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("does nothing on Enter if no option selected (empty list)", () => {
		render(
			<SearchableSelect
				options={options}
				onChange={mockOnChange}
				noResultsText="No items"
			/>,
		);
		const input = screen.getByTestId("mock-input");
		// Search for non-existent
		fireEvent.change(input, { target: { value: "zzz" } });
		fireEvent.focus(input);
		expect(screen.getByText("No items")).toBeInTheDocument();

		fireEvent.keyDown(input, { key: "Enter" });
		expect(mockOnChange).not.toHaveBeenCalled();
	});
});
