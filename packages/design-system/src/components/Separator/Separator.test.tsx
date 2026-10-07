import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Separator } from "./Separator";

// Mock Radix UI Separator
vi.mock("@radix-ui/react-separator", () => ({
	Root: React.forwardRef<
		HTMLDivElement,
		{
			className?: string;
			decorative?: boolean;
			orientation?: "horizontal" | "vertical";
			[key: string]: unknown;
		}
	>(
		(
			{
				className,
				decorative,
				orientation,
				...props
			}: {
				className?: string;
				decorative?: boolean;
				orientation?: "horizontal" | "vertical";
				[key: string]: unknown;
			},
			ref,
		) => (
			// biome-ignore lint/a11y/useAriaPropsSupportedByRole: Valid when role is separator
			<div
				data-testid="separator-root"
				className={className}
				ref={ref}
				data-decorative={decorative}
				data-orientation={orientation}
				role={decorative ? "none" : "separator"}
				aria-orientation={decorative ? undefined : orientation}
				{...props}
			/>
		),
	),
}));

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

describe("Separator Component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Basic Rendering", () => {
		it("renders separator with default props", () => {
			render(<Separator />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toBeInTheDocument();
			expect(separator).toHaveAttribute("data-decorative", "true");
			expect(separator).toHaveAttribute("data-orientation", "horizontal");
			expect(separator).toHaveAttribute("role", "none");
		});

		it("renders with custom className", () => {
			render(<Separator className="custom-separator" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("custom-separator");
		});

		it("renders without children", () => {
			render(<Separator />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toBeInTheDocument();
			expect(separator).toBeEmptyDOMElement();
		});
	});

	describe("Orientation Variants", () => {
		it("renders horizontal orientation by default", () => {
			render(<Separator />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-orientation", "horizontal");
			expect(separator).toHaveClass("h-[1px]", "w-full");
		});

		it("renders horizontal orientation explicitly", () => {
			render(<Separator orientation="horizontal" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-orientation", "horizontal");
			expect(separator).toHaveClass("h-[1px]", "w-full");
		});

		it("renders vertical orientation", () => {
			render(<Separator orientation="vertical" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-orientation", "vertical");
			expect(separator).toHaveClass("h-full", "w-[1px]");
		});
	});

	describe("Decorative Property", () => {
		it("renders as decorative by default", () => {
			render(<Separator />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-decorative", "true");
			expect(separator).toHaveAttribute("role", "none");
			expect(separator).not.toHaveAttribute("aria-orientation");
		});

		it("renders as decorative when explicitly set", () => {
			render(<Separator decorative={true} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-decorative", "true");
			expect(separator).toHaveAttribute("role", "none");
		});

		it("renders as non-decorative when set to false", () => {
			render(<Separator decorative={false} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-decorative", "false");
			expect(separator).toHaveAttribute("role", "separator");
			expect(separator).toHaveAttribute("aria-orientation", "horizontal");
		});

		it("renders vertical non-decorative separator", () => {
			render(<Separator orientation="vertical" decorative={false} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-decorative", "false");
			expect(separator).toHaveAttribute("role", "separator");
			expect(separator).toHaveAttribute("aria-orientation", "vertical");
		});
	});

	describe("Default Classes", () => {
		it("applies default styling classes", () => {
			render(<Separator />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("shrink-0", "bg-border");
		});

		it("combines default classes with custom classes", () => {
			render(<Separator className="custom-class another-class" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass(
				"shrink-0",
				"bg-border",
				"custom-class",
				"another-class",
			);
		});

		it("combines orientation classes with custom classes", () => {
			render(<Separator orientation="vertical" className="custom-vertical" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass(
				"shrink-0",
				"bg-border",
				"h-full",
				"w-[1px]",
				"custom-vertical",
			);
		});
	});

	describe("Props Handling", () => {
		it("passes through data attributes", () => {
			render(<Separator data-testid="custom-separator" data-custom="test" />);

			const separator = screen.getByTestId("custom-separator");
			expect(separator).toHaveAttribute("data-custom", "test");
		});

		it("passes through style prop", () => {
			render(<Separator style={{ margin: "10px", padding: "5px" }} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveStyle({ margin: "10px", padding: "5px" });
		});

		it("passes through aria attributes", () => {
			render(<Separator aria-label="Separator" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("aria-label", "Separator");
		});
	});

	describe("Forward Ref", () => {
		it("forwards ref correctly", () => {
			const ref = { current: null };

			render(<Separator ref={ref} />);

			expect(ref.current).toBe(screen.getByTestId("separator-root"));
		});

		it("works with null ref", () => {
			expect(() => {
				render(<Separator ref={null} />);
			}).not.toThrow();
		});
	});

	describe("Accessibility", () => {
		it("has proper role for decorative separator", () => {
			render(<Separator decorative={true} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("role", "none");
		});

		it("has proper role for non-decorative separator", () => {
			render(<Separator decorative={false} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("role", "separator");
		});

		it("has proper aria-orientation for non-decorative separator", () => {
			render(<Separator orientation="vertical" decorative={false} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("aria-orientation", "vertical");
		});

		it("does not have aria-orientation for decorative separator", () => {
			render(<Separator orientation="vertical" decorative={true} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).not.toHaveAttribute("aria-orientation");
		});
	});

	describe("Component Structure", () => {
		it("renders as div element", () => {
			render(<Separator />);

			const separator = screen.getByTestId("separator-root");
			expect(separator.tagName).toBe("DIV");
		});

		it("has correct dimensions for horizontal", () => {
			render(<Separator orientation="horizontal" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("h-[1px]", "w-full");
		});

		it("has correct dimensions for vertical", () => {
			render(<Separator orientation="vertical" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("h-full", "w-[1px]");
		});
	});

	describe("Edge Cases", () => {
		it("handles empty string className", () => {
			render(<Separator className="" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("shrink-0", "bg-border");
		});

		it("handles undefined className", () => {
			render(<Separator className={undefined} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("shrink-0", "bg-border");
		});

		it("handles all props combinations", () => {
			render(
				<Separator
					orientation="vertical"
					decorative={false}
					className="test-class"
					data-test="value"
				/>,
			);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-orientation", "vertical");
			expect(separator).toHaveAttribute("data-decorative", "false");
			expect(separator).toHaveAttribute("data-test", "value");
			expect(separator).toHaveClass("test-class");
		});
	});

	describe("Component Behavior", () => {
		it("handles prop changes", () => {
			const { rerender } = render(<Separator orientation="horizontal" />);

			let separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-orientation", "horizontal");
			expect(separator).toHaveClass("h-[1px]", "w-full");

			rerender(<Separator orientation="vertical" />);

			separator = screen.getByTestId("separator-root");
			expect(separator).toHaveAttribute("data-orientation", "vertical");
			expect(separator).toHaveClass("h-full", "w-[1px]");
		});

		it("maintains default classes during re-renders", () => {
			const { rerender } = render(<Separator />);

			let separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("shrink-0", "bg-border");

			rerender(<Separator className="new-class" />);

			separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("shrink-0", "bg-border", "new-class");
		});
	});

	describe("Export", () => {
		it("exports Separator component correctly", () => {
			expect(Separator).toBeDefined();
			expect(typeof Separator).toBe("object"); // forwardRef component is an object
		});
	});

	describe("Styling Variations", () => {
		it("applies custom styling correctly", () => {
			render(<Separator className="bg-red-500 h-2" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("bg-red-500", "h-2");
			expect(separator).toHaveClass("shrink-0"); // should still have default
		});

		it("handles responsive classes", () => {
			render(<Separator className="md:h-2 lg:h-3" />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).toHaveClass("md:h-2", "lg:h-3");
		});

		it("handles conditional classes", () => {
			const isHidden = false;
			render(<Separator className={isHidden ? "hidden" : ""} />);

			const separator = screen.getByTestId("separator-root");
			expect(separator).not.toHaveClass("hidden");
		});
	});
});
