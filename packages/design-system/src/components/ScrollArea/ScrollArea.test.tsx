import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollArea } from "./ScrollArea";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

describe("ScrollArea Component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Basic Rendering", () => {
		it("renders scroll area with children", () => {
			render(
				<ScrollArea data-testid="scroll-area">
					<div>Scrollable content</div>
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toBeInTheDocument();
			expect(scrollArea).toHaveClass("relative", "overflow-auto");
			expect(screen.getByText("Scrollable content")).toBeInTheDocument();
		});

		it("renders with custom className", () => {
			render(
				<ScrollArea data-testid="scroll-area" className="custom-scroll-area">
					<div>Content</div>
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("custom-scroll-area");
			expect(scrollArea).toHaveClass("relative", "overflow-auto");
		});

		it("renders with complex children", () => {
			render(
				<ScrollArea data-testid="scroll-area">
					<div>
						<h1>Title</h1>
						<p>Paragraph</p>
						<ul>
							<li>Item 1</li>
							<li>Item 2</li>
						</ul>
					</div>
				</ScrollArea>,
			);

			expect(screen.getByText("Title")).toBeInTheDocument();
			expect(screen.getByText("Paragraph")).toBeInTheDocument();
			expect(screen.getByText("Item 1")).toBeInTheDocument();
			expect(screen.getByText("Item 2")).toBeInTheDocument();
		});

		it("renders with empty children", () => {
			render(<ScrollArea data-testid="scroll-area">{null}</ScrollArea>);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toBeInTheDocument();
			expect(scrollArea).toBeEmptyDOMElement();
		});
	});

	describe("Props Handling", () => {
		it("passes through HTML attributes", () => {
			render(
				<ScrollArea data-testid="scroll-area" role="region">
					<div>Content</div>
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toBeInTheDocument();
			expect(scrollArea).toHaveAttribute("role", "region");
		});

		it("passes through style prop", () => {
			render(
				<ScrollArea
					data-testid="scroll-area"
					style={{ height: "200px", width: "300px" }}
				>
					<div>Content</div>
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveStyle({ height: "200px", width: "300px" });
		});

		it("passes through aria attributes", () => {
			render(
				<ScrollArea
					data-testid="scroll-area"
					aria-label="Scrollable content"
					aria-busy={true}
				>
					<div>Content</div>
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveAttribute("aria-label", "Scrollable content");
			expect(scrollArea).toHaveAttribute("aria-busy", "true");
		});
	});

	describe("Default Classes", () => {
		it("applies default styling classes", () => {
			render(<ScrollArea data-testid="scroll-area">Content</ScrollArea>);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("relative", "overflow-auto");
		});

		it("combines default classes with custom classes", () => {
			render(
				<ScrollArea
					data-testid="scroll-area"
					className="custom-class another-class"
				>
					Content
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass(
				"relative",
				"overflow-auto",
				"custom-class",
				"another-class",
			);
		});
	});

	describe("Forward Ref", () => {
		it("forwards ref correctly", () => {
			const ref = { current: null };

			render(
				<ScrollArea ref={ref} data-testid="scroll-area">
					Content
				</ScrollArea>,
			);

			expect(ref.current).toBe(screen.getByTestId("scroll-area"));
		});

		it("works with null ref", () => {
			expect(() => {
				render(
					<ScrollArea ref={null} data-testid="scroll-area">
						Content
					</ScrollArea>,
				);
			}).not.toThrow();
		});
	});

	describe("Component Structure", () => {
		it("renders as div element", () => {
			render(<ScrollArea data-testid="scroll-area">Content</ScrollArea>);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea.tagName).toBe("DIV");
		});

		it("contains children properly", () => {
			render(
				<ScrollArea data-testid="scroll-area">
					<div data-testid="child-content">Child Content</div>
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			const child = screen.getByTestId("child-content");

			expect(scrollArea).toContainElement(child);
		});
	});

	describe("Edge Cases", () => {
		it("handles empty string className", () => {
			render(
				<ScrollArea data-testid="scroll-area" className="">
					Content
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("relative", "overflow-auto");
		});

		it("handles undefined className", () => {
			render(
				<ScrollArea data-testid="scroll-area" className={undefined}>
					Content
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("relative", "overflow-auto");
		});

		it("handles null children", () => {
			render(<ScrollArea data-testid="scroll-area">{null}</ScrollArea>);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toBeInTheDocument();
			expect(scrollArea).toBeEmptyDOMElement();
		});

		it("handles multiple children", () => {
			render(
				<ScrollArea data-testid="scroll-area">
					<div>First</div>
					<div>Second</div>
					<div>Third</div>
				</ScrollArea>,
			);

			expect(screen.getByText("First")).toBeInTheDocument();
			expect(screen.getByText("Second")).toBeInTheDocument();
			expect(screen.getByText("Third")).toBeInTheDocument();
		});
	});

	describe("Component Behavior", () => {
		it("handles prop changes", () => {
			const { rerender } = render(
				<ScrollArea data-testid="scroll-area" className="initial">
					Content
				</ScrollArea>,
			);

			let scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("initial");

			rerender(
				<ScrollArea data-testid="scroll-area" className="updated">
					Content
				</ScrollArea>,
			);

			scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("updated");
		});

		it("maintains default classes during re-renders", () => {
			const { rerender } = render(
				<ScrollArea data-testid="scroll-area">Content</ScrollArea>,
			);

			let scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("relative", "overflow-auto");

			rerender(
				<ScrollArea data-testid="scroll-area" className="new-class">
					Content
				</ScrollArea>,
			);

			scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("relative", "overflow-auto", "new-class");
		});
	});

	describe("Memoization", () => {
		it("is memoized component", () => {
			expect(ScrollArea.$$typeof).toBe(Symbol.for("react.memo"));
		});

		it("has correct displayName", () => {
			expect(ScrollArea.displayName).toBe("ScrollArea");
		});
	});

	describe("Export", () => {
		it("exports ScrollArea component correctly", () => {
			expect(ScrollArea).toBeDefined();
			expect(typeof ScrollArea).toBe("object"); // memoized component is an object
		});
	});

	describe("Styling Variations", () => {
		it("applies custom styling correctly", () => {
			render(
				<ScrollArea
					data-testid="scroll-area"
					className="bg-red-500 h-64 w-full"
				>
					Content
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("bg-red-500", "h-64", "w-full");
			expect(scrollArea).toHaveClass("relative"); // should still have default
		});

		it("handles responsive classes", () => {
			render(
				<ScrollArea data-testid="scroll-area" className="h-32 md:h-48 lg:h-64">
					Content
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("h-32", "md:h-48", "lg:h-64");
		});

		it("handles conditional classes", () => {
			const isHidden = false;
			render(
				<ScrollArea
					data-testid="scroll-area"
					className={isHidden ? "hidden" : ""}
				>
					Content
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("relative", "overflow-auto");
		});
	});

	describe("Accessibility", () => {
		it("supports accessibility attributes", () => {
			render(
				<ScrollArea
					data-testid="scroll-area"
					role="region"
					aria-label="Scrollable content area"
					aria-roledescription="scrollable container"
				>
					<div>Content</div>
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveAttribute("role", "region");
			expect(scrollArea).toHaveAttribute(
				"aria-label",
				"Scrollable content area",
			);
			expect(scrollArea).toHaveAttribute(
				"aria-roledescription",
				"scrollable container",
			);
		});

		it("supports tabindex for keyboard navigation", () => {
			render(
				<ScrollArea data-testid="scroll-area" tabIndex={0}>
					Content
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveAttribute("tabindex", "0");
		});
	});

	describe("Integration", () => {
		it("works with nested components", () => {
			render(
				<ScrollArea data-testid="scroll-area" className="h-40">
					<div className="space-y-4">
						<div className="p-4 bg-gray-100">Section 1</div>
						<div className="p-4 bg-gray-200">Section 2</div>
						<div className="p-4 bg-gray-300">Section 3</div>
					</div>
				</ScrollArea>,
			);

			expect(screen.getByText("Section 1")).toBeInTheDocument();
			expect(screen.getByText("Section 2")).toBeInTheDocument();
			expect(screen.getByText("Section 3")).toBeInTheDocument();

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toHaveClass("h-40");
		});

		it("works with text content", () => {
			render(
				<ScrollArea data-testid="scroll-area">
					Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do
					eiusmod tempor incididunt ut labore et dolore magna aliqua.
				</ScrollArea>,
			);

			const scrollArea = screen.getByTestId("scroll-area");
			expect(scrollArea).toBeInTheDocument();
			expect(scrollArea).toHaveClass("relative", "overflow-auto");
			expect(screen.getByText(/Lorem ipsum/)).toBeInTheDocument();
		});
	});
});
