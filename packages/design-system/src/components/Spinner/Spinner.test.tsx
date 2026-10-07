import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Spinner } from "./Spinner";

describe("Spinner Component", () => {
	describe("Basic Rendering", () => {
		it("renders spinner container", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();
			expect(spinner).toHaveAttribute("aria-label", "Loading");
		});

		it("renders with default size (md) and variant (primary)", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();

			const innerSpinner = spinner.querySelector("div");
			expect(innerSpinner).toHaveClass(
				"animate-spin",
				"rounded-full",
				"h-8",
				"w-8",
				"border-[3px]",
				"border-theme-object-primary",
				"border-t-transparent",
			);
		});

		it("renders screen reader only text", () => {
			render(<Spinner />);

			const srText = screen.getByText("loading");
			expect(srText).toBeInTheDocument();
			expect(srText).toHaveClass("sr-only");
		});
	});

	describe("Size Variants", () => {
		it("renders xs size", () => {
			render(<Spinner size="xs" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("h-4", "w-4", "border-2");
		});

		it("renders sm size", () => {
			render(<Spinner size="sm" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("h-6", "w-6", "border-2");
		});

		it("renders md size (default)", () => {
			render(<Spinner size="md" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("h-8", "w-8", "border-[3px]");
		});

		it("renders lg size", () => {
			render(<Spinner size="lg" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("h-12", "w-12", "border-[3px]");
		});

		it("renders xl size", () => {
			render(<Spinner size="xl" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("h-16", "w-16", "border-4");
		});
	});

	describe("Variant Variants", () => {
		it("renders primary variant (default)", () => {
			render(<Spinner variant="primary" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass(
				"border-theme-object-primary",
				"border-t-transparent",
			);
		});

		it("renders secondary variant", () => {
			render(<Spinner variant="secondary" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass(
				"border-theme-text-secondary",
				"border-t-transparent",
			);
		});

		it("renders accent variant", () => {
			render(<Spinner variant="accent" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass(
				"border-theme-accent",
				"border-t-transparent",
			);
		});
	});

	describe("Size and Variant Combinations", () => {
		it("renders xs size with secondary variant", () => {
			render(<Spinner size="xs" variant="secondary" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass(
				"h-4",
				"w-4",
				"border-2", // xs size
				"border-theme-text-secondary",
				"border-t-transparent", // secondary variant
			);
		});

		it("renders xl size with accent variant", () => {
			render(<Spinner size="xl" variant="accent" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass(
				"h-16",
				"w-16",
				"border-4", // xl size
				"border-theme-accent",
				"border-t-transparent", // accent variant
			);
		});
	});

	describe("Styling", () => {
		it("applies custom className", () => {
			render(<Spinner className="custom-spinner" />);

			const spinner = screen.getByRole("status");
			expect(spinner).toHaveClass("custom-spinner");
			expect(spinner).toHaveClass("inline-block"); // Should still have default classes
		});

		it("applies default styling classes", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toHaveClass("inline-block");

			const innerSpinner = spinner.querySelector("div");
			expect(innerSpinner).toHaveClass(
				"animate-spin",
				"rounded-full",
				"h-8",
				"w-8",
				"border-[3px]",
				"border-theme-object-primary",
				"border-t-transparent",
			);
		});

		it("merges custom classes with default classes", () => {
			render(<Spinner className="custom-class" />);

			const spinner = screen.getByRole("status");
			expect(spinner).toHaveClass("custom-class");
			expect(spinner).toHaveClass("inline-block"); // Should still have other default classes
		});
	});

	describe("Props and Attributes", () => {
		it("passes through HTML attributes", () => {
			render(
				<Spinner
					data-testid="test-spinner"
					id="spinner-1"
					title="Loading indicator"
				/>,
			);

			const spinner = screen.getByRole("status");
			expect(spinner).toHaveAttribute("data-testid", "test-spinner");
			expect(spinner).toHaveAttribute("id", "spinner-1");
			expect(spinner).toHaveAttribute("title", "Loading indicator");
		});

		it("handles click events", () => {
			const handleClick = vi.fn();
			render(<Spinner onClick={handleClick} />);

			const spinner = screen.getByRole("status");
			(spinner as HTMLElement).click();

			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it("maintains accessibility attributes", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			// expect(spinner).toHaveAttribute("role", "status");
			expect(spinner).toHaveAttribute("aria-label", "Loading");
		});
	});

	describe("Component Properties", () => {
		it("has correct displayName", () => {
			expect(Spinner.displayName).toBe("Spinner");
		});

		it("is memoized component", () => {
			const { rerender } = render(<Spinner />);

			// Initial render
			expect(screen.getByRole("status")).toBeInTheDocument();

			// Rerender with same props
			rerender(<Spinner />);
			expect(screen.getByRole("status")).toBeInTheDocument();
		});
	});

	describe("Animation Classes", () => {
		it("includes animate-spin class", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("animate-spin");
		});

		it("includes rounded-full class", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("rounded-full");
		});
	});

	describe("Border Styles", () => {
		it("applies correct border styles for each size", () => {
			const sizeTests = [
				{ size: "xs", border: "border-2" },
				{ size: "sm", border: "border-2" },
				{ size: "md", border: "border-[3px]" },
				{ size: "lg", border: "border-[3px]" },
				{ size: "xl", border: "border-4" },
			];

			sizeTests.forEach(({ size, border }) => {
				// biome-ignore lint/suspicious/noExplicitAny: Bypassing strict union check
				const { unmount } = render(<Spinner size={size as any} />);

				const spinner = screen.getByRole("status");
				const innerSpinner = spinner.querySelector("div");

				expect(innerSpinner).toHaveClass(border);

				unmount();
			});
		});

		it("applies transparent top border for spinning effect", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("border-t-transparent");
		});
	});

	describe("Accessibility", () => {
		it("has proper role for screen readers", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();
		});

		it("provides aria-label for screen readers", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toHaveAttribute("aria-label", "Loading");
		});

		it("includes screen reader only text", () => {
			render(<Spinner />);

			const srText = screen.getByText("loading");
			expect(srText).toHaveClass("sr-only");
		});

		it("maintains semantic structure", () => {
			render(<Spinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();

			const innerSpinner = spinner.querySelector("div");
			expect(innerSpinner).toBeInTheDocument();

			const srText = screen.getByText("loading");
			expect(srText).toBeInTheDocument();
		});
	});

	describe("Edge Cases", () => {
		it("handles all prop combinations", () => {
			const combinations = [
				{ size: "xs" as const, variant: "primary" as const },
				{ size: "sm" as const, variant: "secondary" as const },
				{ size: "md" as const, variant: "accent" as const },
				{ size: "lg" as const, variant: "primary" as const },
				{ size: "xl" as const, variant: "secondary" as const },
			];

			combinations.forEach(({ size, variant }) => {
				const { unmount } = render(<Spinner size={size} variant={variant} />);

				const spinner = screen.getByRole("status");
				expect(spinner).toBeInTheDocument();

				const innerSpinner = spinner.querySelector("div");
				expect(innerSpinner).toBeInTheDocument();

				unmount();
			});
		});

		it("handles empty className", () => {
			render(<Spinner className="" />);

			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();
			expect(spinner).toHaveClass("inline-block");
		});

		it("handles additional props gracefully", () => {
			render(<Spinner data-custom="custom-value" style={{ zIndex: 1000 }} />);

			const spinner = screen.getByRole("status");
			expect(spinner).toHaveAttribute("data-custom", "custom-value");
			expect(spinner).toHaveStyle({ zIndex: "1000" });
		});
	});
});
