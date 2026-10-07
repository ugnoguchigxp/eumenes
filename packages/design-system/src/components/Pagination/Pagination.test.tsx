import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pagination } from "./Pagination";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

// Mock Button component
vi.mock("../../../src/components/Button", () => ({
	Button: ({
		children,
		onClick,
		disabled,
		"aria-label": ariaLabel,
	}: {
		children?: React.ReactNode;
		onClick?: () => void;
		disabled?: boolean;
		"aria-label"?: string;
	}) => (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={ariaLabel}
		>
			{children}
		</button>
	),
}));

// Mock Lucide icons
vi.mock("lucide-react", () => ({
	ChevronLeft: () => <span>PrevIcon</span>,
	ChevronRight: () => <span>NextIcon</span>,
}));

describe("Pagination Component", () => {
	const mockOnPrev = vi.fn();
	const mockOnNext = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders page info and controls", () => {
		render(
			<Pagination
				currentPage={2}
				totalPages={5}
				onPrevPage={mockOnPrev}
				onNextPage={mockOnNext}
			/>,
		);

		expect(screen.getByText("2 / 5")).toBeInTheDocument();
		expect(screen.getByLabelText("Previous page")).toBeInTheDocument();
		expect(screen.getByLabelText("Next page")).toBeInTheDocument();
	});

	it("renders nothing if totalPages <= 1", () => {
		const { container } = render(
			<Pagination
				currentPage={1}
				totalPages={1}
				onPrevPage={mockOnPrev}
				onNextPage={mockOnNext}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("disables Prev button on first page", () => {
		render(
			<Pagination
				currentPage={1}
				totalPages={5}
				onPrevPage={mockOnPrev}
				onNextPage={mockOnNext}
			/>,
		);

		const prevBtn = screen.getByLabelText("Previous page");
		expect(prevBtn).toBeDisabled();

		fireEvent.click(prevBtn);
		expect(mockOnPrev).not.toHaveBeenCalled();
	});

	it("disables Next button on last page", () => {
		render(
			<Pagination
				currentPage={5}
				totalPages={5}
				onPrevPage={mockOnPrev}
				onNextPage={mockOnNext}
			/>,
		);

		const nextBtn = screen.getByLabelText("Next page");
		expect(nextBtn).toBeDisabled();

		fireEvent.click(nextBtn);
		expect(mockOnNext).not.toHaveBeenCalled();
	});

	it("calls onNextPage when Next is clicked", () => {
		render(
			<Pagination
				currentPage={2}
				totalPages={5}
				onPrevPage={mockOnPrev}
				onNextPage={mockOnNext}
			/>,
		);

		const nextBtn = screen.getByLabelText("Next page");
		fireEvent.click(nextBtn);
		expect(mockOnNext).toHaveBeenCalled();
	});

	it("calls onPrevPage when Prev is clicked", () => {
		render(
			<Pagination
				currentPage={2}
				totalPages={5}
				onPrevPage={mockOnPrev}
				onNextPage={mockOnNext}
			/>,
		);

		const prevBtn = screen.getByLabelText("Previous page");
		fireEvent.click(prevBtn);
		expect(mockOnPrev).toHaveBeenCalled();
	});

	it("uses custom formatter", () => {
		render(
			<Pagination
				currentPage={2}
				totalPages={5}
				onPrevPage={mockOnPrev}
				onNextPage={mockOnNext}
				pageInfoFormatter={(current, total) => `Page ${current} of ${total}`}
			/>,
		);

		expect(screen.getByText("Page 2 of 5")).toBeInTheDocument();
	});
});
