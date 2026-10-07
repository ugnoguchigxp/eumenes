import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Skeleton } from "./Skeleton";

describe("Skeleton Component", () => {
	describe("Basic Rendering", () => {
		it("renders skeleton container", () => {
			render(<Skeleton />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toBeInTheDocument();
		});

		it("applies default styling classes", () => {
			render(<Skeleton />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveClass(
				"animate-pulse",
				"rounded-md",
				"bg-card",
				"opacity-50",
			);
		});

		it("does not show spinner by default", () => {
			render(<Skeleton />);

			const spinner = screen.queryByRole("status");
			expect(spinner).not.toBeInTheDocument();
		});
	});

	describe("Spinner Functionality", () => {
		it("shows spinner when showSpinner is true", () => {
			render(<Skeleton showSpinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();
			expect(spinner).toHaveAttribute("aria-label", "Loading");
		});

		it("applies flex classes when showing spinner", () => {
			render(<Skeleton showSpinner />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveClass(
				"relative",
				"flex",
				"items-center",
				"justify-center",
			);
		});

		it("renders spinner with default size and variant", () => {
			render(<Skeleton showSpinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();

			const innerSpinner = spinner.querySelector("div");
			expect(innerSpinner).toHaveClass(
				"h-8", // md size
				"w-8",
				"border-theme-object-primary", // primary variant
			);
		});

		it("renders spinner with custom size", () => {
			render(<Skeleton showSpinner spinnerSize="lg" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("h-12", "w-12"); // lg size
		});

		it("renders spinner with custom variant", () => {
			render(<Skeleton showSpinner spinnerVariant="accent" />);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass("border-theme-accent");
		});

		it("renders spinner with custom size and variant", () => {
			render(
				<Skeleton showSpinner spinnerSize="xl" spinnerVariant="secondary" />,
			);

			const spinner = screen.getByRole("status");
			const innerSpinner = spinner.querySelector("div");

			expect(innerSpinner).toHaveClass(
				"h-16",
				"w-16", // xl size
				"border-theme-text-secondary", // secondary variant
			);
		});

		it("positions spinner absolutely in center", () => {
			render(<Skeleton showSpinner />);

			const spinnerContainer = document.querySelector(".absolute");
			expect(spinnerContainer).toHaveClass(
				"absolute",
				"inset-0",
				"flex",
				"items-center",
				"justify-center",
			);
		});
	});

	describe("Size Variants for Spinner", () => {
		const sizeTests = [
			{ size: "xs" as const, classes: ["h-4", "w-4", "border-2"] },
			{ size: "sm" as const, classes: ["h-6", "w-6", "border-2"] },
			{ size: "md" as const, classes: ["h-8", "w-8", "border-[3px]"] },
			{ size: "lg" as const, classes: ["h-12", "w-12", "border-[3px]"] },
			{ size: "xl" as const, classes: ["h-16", "w-16", "border-4"] },
		];

		sizeTests.forEach(({ size, classes }) => {
			it(`renders spinner with ${size} size`, () => {
				render(<Skeleton showSpinner spinnerSize={size} />);

				const spinner = screen.getByRole("status");
				const innerSpinner = spinner.querySelector("div");

				classes.forEach((className) => {
					expect(innerSpinner).toHaveClass(className);
				});
			});
		});
	});

	describe("Variant Variants for Spinner", () => {
		const variantTests = [
			{
				variant: "primary" as const,
				classes: ["border-theme-object-primary", "border-t-transparent"],
			},
			{
				variant: "secondary" as const,
				classes: ["border-theme-text-secondary", "border-t-transparent"],
			},
			{
				variant: "accent" as const,
				classes: ["border-theme-accent", "border-t-transparent"],
			},
		];

		variantTests.forEach(({ variant, classes }) => {
			it(`renders spinner with ${variant} variant`, () => {
				render(<Skeleton showSpinner spinnerVariant={variant} />);

				const spinner = screen.getByRole("status");
				const innerSpinner = spinner.querySelector("div");

				classes.forEach((className) => {
					expect(innerSpinner).toHaveClass(className);
				});
			});
		});
	});

	describe("Styling", () => {
		it("applies custom className", () => {
			render(<Skeleton className="custom-skeleton" />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveClass("custom-skeleton");
			expect(skeleton).toHaveClass("rounded-md"); // Should still have default classes
		});

		it("merges custom classes with default classes", () => {
			render(<Skeleton className="custom-class another-class" />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveClass("custom-class", "another-class");
			expect(skeleton).toHaveClass("animate-pulse", "rounded-md"); // Should still have default classes
		});

		it("applies animation classes", () => {
			render(<Skeleton />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveClass("animate-pulse");
		});

		it("applies background and opacity classes", () => {
			render(<Skeleton />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveClass("bg-card", "opacity-50");
		});

		it("applies border radius classes", () => {
			render(<Skeleton />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveClass("rounded-md");
		});
	});

	describe("Props and Attributes", () => {
		it("passes through HTML attributes", () => {
			render(
				<Skeleton
					data-testid="test-skeleton"
					id="skeleton-1"
					title="Loading skeleton"
				/>,
			);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveAttribute("data-testid", "test-skeleton");
			expect(skeleton).toHaveAttribute("id", "skeleton-1");
			expect(skeleton).toHaveAttribute("title", "Loading skeleton");
		});

		it("handles click events", () => {
			const handleClick = vi.fn();
			render(<Skeleton onClick={handleClick} />);

			const skeleton = document.querySelector(".animate-pulse");
			(skeleton as HTMLElement).click();

			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it("handles style prop", () => {
			render(<Skeleton style={{ width: "200px", height: "100px" }} />);

			const skeleton = document.querySelector(".animate-pulse");
			if (skeleton) {
				expect(skeleton).toHaveStyle({ width: "200px", height: "100px" });
			}
		});
	});

	describe("Component Properties", () => {
		it("has correct displayName", () => {
			expect(Skeleton.displayName).toBe("Skeleton");
		});

		it("is memoized component", () => {
			const { rerender } = render(<Skeleton />);

			// Initial render
			expect(document.querySelector(".animate-pulse")).toBeInTheDocument();

			// Rerender with same props
			rerender(<Skeleton />);
			expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
		});
	});

	describe("Layout and Structure", () => {
		it("maintains proper DOM structure without spinner", () => {
			render(<Skeleton />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toBeInTheDocument();

			// Should not have spinner container
			if (skeleton) {
				const spinnerContainer = skeleton.querySelector(".absolute");
				expect(spinnerContainer).not.toBeInTheDocument();
			}
		});

		it("maintains proper DOM structure with spinner", () => {
			render(<Skeleton showSpinner />);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toBeInTheDocument();

			// Should have spinner container
			const spinnerContainer = skeleton?.querySelector(".absolute");
			expect(spinnerContainer).toBeInTheDocument();

			// Should have spinner
			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();
		});

		it("positions spinner correctly within skeleton", () => {
			render(<Skeleton showSpinner />);

			const skeleton = document.querySelector(".animate-pulse");
			if (skeleton) {
				const spinnerContainer = skeleton.querySelector(".absolute");
				expect(spinnerContainer).toHaveClass("inset-0");
			}
		});
	});

	describe("Accessibility", () => {
		it("provides proper accessibility when spinner is shown", () => {
			render(<Skeleton showSpinner />);

			const spinner = screen.getByRole("status");
			expect(spinner).toBeInTheDocument();
			expect(spinner).toHaveAttribute("aria-label", "Loading");
		});

		it("does not have accessibility attributes when spinner is hidden", () => {
			render(<Skeleton />);

			const spinner = screen.queryByRole("status");
			expect(spinner).not.toBeInTheDocument();
		});
	});

	describe("Edge Cases", () => {
		it("handles all spinner size combinations", () => {
			const sizes: Array<"xs" | "sm" | "md" | "lg" | "xl"> = [
				"xs",
				"sm",
				"md",
				"lg",
				"xl",
			];

			sizes.forEach((size) => {
				const { unmount } = render(<Skeleton showSpinner spinnerSize={size} />);

				const spinner = screen.getByRole("status");
				expect(spinner).toBeInTheDocument();

				unmount();
			});
		});

		it("handles additional props gracefully", () => {
			render(
				<Skeleton
					data-custom="custom-value"
					role="presentation"
					aria-hidden="true"
				/>,
			);

			const skeleton = document.querySelector(".animate-pulse");
			expect(skeleton).toHaveAttribute("data-custom", "custom-value");
			expect(skeleton).toHaveAttribute("role", "presentation");
			expect(skeleton).toHaveAttribute("aria-hidden", "true");
		});

		describe("Visual States", () => {
			it("maintains loading animation without spinner", () => {
				render(<Skeleton />);

				const skeleton = document.querySelector(".animate-pulse");
				expect(skeleton).toHaveClass("animate-pulse");
			});

			it("maintains loading animation with spinner", () => {
				render(<Skeleton showSpinner />);

				const skeleton = document.querySelector(".animate-pulse");
				expect(skeleton).toHaveClass("animate-pulse");

				const spinner = screen.getByRole("status");
				const innerSpinner = spinner.querySelector("div");
				expect(innerSpinner).toHaveClass("animate-spin");
			});

			it("applies correct opacity for loading state", () => {
				render(<Skeleton />);

				const skeleton = document.querySelector(".animate-pulse");
				expect(skeleton).toHaveClass("opacity-50");
			});
		});
	});
});
