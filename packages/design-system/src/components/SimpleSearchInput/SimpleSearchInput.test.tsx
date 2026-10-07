import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleSearchInput } from "./SimpleSearchInput";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

// Mock Lucide icons
vi.mock("lucide-react", () => ({
	Search: () => <div data-testid="icon-search" />,
}));

describe("SimpleSearchInput Component", () => {
	const mockOnSearch = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders correctly", () => {
		render(
			<SimpleSearchInput
				onSearch={mockOnSearch}
				placeholder="Search content..."
			/>,
		);

		const input = screen.getByPlaceholderText("Search content...");
		expect(input).toBeInTheDocument();
		expect(screen.getByTestId("icon-search")).toBeInTheDocument();
	});

	it("calls onSearch when value changes", () => {
		render(<SimpleSearchInput onSearch={mockOnSearch} />);

		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "query" } });

		expect(mockOnSearch).toHaveBeenCalledWith("query");
	});

	it("forwards refs correctly", () => {
		const ref = React.createRef<HTMLInputElement>();
		render(<SimpleSearchInput onSearch={mockOnSearch} ref={ref} />);

		expect(ref.current).toBeInstanceOf(HTMLInputElement);
	});

	it("applies custom className", () => {
		render(
			<SimpleSearchInput onSearch={mockOnSearch} className="custom-class" />,
		);

		const input = screen.getByRole("textbox");
		expect(input).toHaveClass("custom-class");
	});

	it("passes standard input props", () => {
		render(
			<SimpleSearchInput onSearch={mockOnSearch} disabled maxLength={5} />,
		);

		const input = screen.getByRole("textbox");
		expect(input).toBeDisabled();
		expect(input).toHaveAttribute("maxLength", "5");
	});
});
