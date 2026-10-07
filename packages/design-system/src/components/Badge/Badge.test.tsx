import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "@/components/Badge/Badge";

describe("Badge", () => {
	it("renders correctly with children", () => {
		render(<Badge>Test Badge</Badge>);
		expect(screen.getByText("Test Badge")).toBeInTheDocument();
	});

	it("renders correctly with label prop", () => {
		render(<Badge label="Label Badge" />);
		expect(screen.getByText("Label Badge")).toBeInTheDocument();
	});

	it("prioritizes label over children when both provided", () => {
		render(<Badge label="Label Badge">Children Badge</Badge>);
		expect(screen.getByText("Label Badge")).toBeInTheDocument();
		expect(screen.queryByText("Children Badge")).not.toBeInTheDocument();
	});

	describe("Variants", () => {
		it("renders default variant", () => {
			render(<Badge>Default</Badge>);
			const badge = screen.getByText("Default");
			expect(badge).toHaveClass("bg-accent", "text-accent-foreground");
		});

		it("renders secondary variant", () => {
			render(<Badge variant="secondary">Secondary</Badge>);
			const badge = screen.getByText("Secondary");
			expect(badge).toHaveClass("bg-secondary", "text-secondary-foreground");
		});

		it("renders destructive variant", () => {
			render(<Badge variant="destructive">Destructive</Badge>);
			const badge = screen.getByText("Destructive");
			expect(badge).toHaveClass(
				"bg-destructive",
				"text-destructive-foreground",
			);
		});

		it("renders outline variant", () => {
			render(<Badge variant="outline">Outline</Badge>);
			const badge = screen.getByText("Outline");
			expect(badge).toHaveClass("text-foreground", "border-border");
		});

		it("renders success variant", () => {
			render(<Badge variant="success">Success</Badge>);
			const badge = screen.getByText("Success");
			expect(badge).toHaveClass("bg-success", "text-success-foreground");
		});

		it("renders warning variant", () => {
			render(<Badge variant="warning">Warning</Badge>);
			const badge = screen.getByText("Warning");
			expect(badge).toHaveClass("bg-warning", "text-warning-foreground");
		});

		// Light background variants for patient list
		it("renders sky variant", () => {
			render(<Badge variant="sky">Sky</Badge>);
			const badge = screen.getByText("Sky");
			expect(badge).toHaveClass("bg-sky-200", "text-sky-900");
		});

		it("renders pink variant", () => {
			render(<Badge variant="pink">Pink</Badge>);
			const badge = screen.getByText("Pink");
			expect(badge).toHaveClass("bg-pink-200", "text-pink-800");
		});

		it("renders gray variant", () => {
			render(<Badge variant="gray">Gray</Badge>);
			const badge = screen.getByText("Gray");
			expect(badge).toHaveClass("bg-stone-200", "text-stone-800");
		});

		it("renders green variant", () => {
			render(<Badge variant="green">Green</Badge>);
			const badge = screen.getByText("Green");
			expect(badge).toHaveClass("bg-teal-200", "text-gray-900");
		});

		it("renders yellow variant", () => {
			render(<Badge variant="yellow">Yellow</Badge>);
			const badge = screen.getByText("Yellow");
			expect(badge).toHaveClass("bg-amber-200", "text-amber-800");
		});

		it("renders red variant", () => {
			render(<Badge variant="red">Red</Badge>);
			const badge = screen.getByText("Red");
			expect(badge).toHaveClass("bg-rose-200", "text-rose-800");
		});
	});

	describe("Props and Attributes", () => {
		it("applies custom className", () => {
			render(<Badge className="custom-class">Custom</Badge>);
			const badge = screen.getByText("Custom");
			expect(badge).toHaveClass("custom-class");
		});

		it("passes through other props", () => {
			render(
				<Badge data-testid="test-badge" title="Badge Title">
					Test
				</Badge>,
			);
			const badge = screen.getByText("Test");
			expect(badge).toHaveAttribute("data-testid", "test-badge");
			expect(badge).toHaveAttribute("title", "Badge Title");
		});

		it("renders complex children", () => {
			render(
				<Badge>
					<span data-testid="complex-child">Complex Content</span>
				</Badge>,
			);
			expect(screen.getByTestId("complex-child")).toBeInTheDocument();
			expect(screen.getByText("Complex Content")).toBeInTheDocument();
		});

		it("handles null children gracefully", () => {
			render(<Badge>{null}</Badge>);
			const badge = document.querySelector(".inline-flex");
			expect(badge).toBeInTheDocument();
		});
	});

	describe("Accessibility", () => {
		it("has focus styles", () => {
			render(<Badge tabIndex={0}>Focusable Badge</Badge>);
			const badge = screen.getByText("Focusable Badge");
			expect(badge).toHaveClass(
				"focus:outline-none",
				"focus:ring-2",
				"focus:ring-ring",
				"focus:ring-offset-2",
			);
		});

		it("prevents text wrapping with whitespace-nowrap", () => {
			render(<Badge>Long Text That Should Not Wrap</Badge>);
			const badge = screen.getByText("Long Text That Should Not Wrap");
			expect(badge).toHaveClass("whitespace-nowrap");
		});
	});

	describe("Base Classes", () => {
		it("has base badge classes", () => {
			render(<Badge>Base Classes</Badge>);
			const badge = screen.getByText("Base Classes");
			expect(badge).toHaveClass(
				"inline-flex",
				"items-center",
				"rounded-full",
				"border",
				"px-[var(--ui-badge-padding-x)]",
				"py-[var(--ui-badge-padding-y)]",
				"font-medium",
				"transition-colors",
			);
		});
	});
});
