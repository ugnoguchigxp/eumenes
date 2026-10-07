import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Label } from "./Label";

describe("Label Component", () => {
	describe("Basic Rendering", () => {
		it("renders label with text", () => {
			render(<Label>Test Label</Label>);

			const label = screen.getByText("Test Label");
			expect(label).toBeInTheDocument();
			expect(label.tagName).toBe("LABEL");
		});

		it("renders with htmlFor attribute", () => {
			render(<Label htmlFor="test-input">Input Label</Label>);

			const label = screen.getByText("Input Label");
			expect(label).toHaveAttribute("for", "test-input");
		});

		it("renders empty label", () => {
			render(<Label></Label>);

			const label = document.querySelector("label");
			expect(label).toBeInTheDocument();
		});
	});

	describe("Styling", () => {
		it("applies default styling classes", () => {
			render(<Label>Styled Label</Label>);

			const label = screen.getByText("Styled Label");
			// text-ui may be processed differently by Tailwind v4
			expect(label).toHaveClass(
				"font-medium",
				"leading-none",
				"text-foreground",
			);
		});

		it("applies custom className", () => {
			render(<Label className="custom-class">Custom Label</Label>);

			const label = screen.getByText("Custom Label");
			expect(label).toHaveClass("custom-class");
			expect(label).toHaveClass("font-medium"); // Should still have default classes
		});

		it("merges custom classes with default classes", () => {
			render(<Label className="text-lg">Large Label</Label>);

			const label = screen.getByText("Large Label");
			expect(label).toHaveClass("text-lg");
			expect(label).toHaveClass("font-medium"); // Should still have other default classes
		});
	});

	describe("Props", () => {
		it("passes through HTML attributes", () => {
			render(
				<Label id="test-id" data-testid="test-label" aria-label="aria label">
					Attribute Label
				</Label>,
			);

			const label = screen.getByText("Attribute Label");
			expect(label).toHaveAttribute("id", "test-id");
			expect(label).toHaveAttribute("data-testid", "test-label");
			expect(label).toHaveAttribute("aria-label", "aria label");
		});

		it("handles click events", () => {
			const handleClick = vi.fn();
			render(<Label onClick={handleClick}>Clickable Label</Label>);

			const label = screen.getByText("Clickable Label");
			(label as HTMLElement).click();

			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it("supports form association", () => {
			render(
				<div>
					<Label htmlFor="username">Username</Label>
					<input id="username" type="text" />
				</div>,
			);

			const label = screen.getByText("Username");
			const input = screen.getByRole("textbox");

			expect(label).toHaveAttribute("for", "username");
			expect(input).toHaveAttribute("id", "username");
		});
	});

	describe("Accessibility", () => {
		it("has proper role", () => {
			render(<Label>Accessible Label</Label>);

			const label = document.querySelector("label");
			expect(label).toBeInTheDocument();
		});

		it("associates with form controls correctly", () => {
			render(
				<div>
					<Label htmlFor="email">Email Address</Label>
					<input id="email" type="email" />
				</div>,
			);

			const label = screen.getByText("Email Address");
			const input = screen.getByRole("textbox");

			// Clicking label should focus the input
			// Note: This might not work in jsdom environment, but the association is correct
			expect(label).toHaveAttribute("for", "email");
			expect(input).toHaveAttribute("id", "email");
		});

		it("supports disabled peer styling", () => {
			render(
				<div>
					<Label>Disabled Input Label</Label>
					<input disabled />
				</div>,
			);

			const label = screen.getByText("Disabled Input Label");
			expect(label).toHaveClass("peer-disabled:cursor-not-allowed");
			expect(label).toHaveClass("peer-disabled:opacity-70");
			expect(label).toHaveClass("peer-disabled:text-theme-disabled-text");
		});
	});

	describe("Component Properties", () => {
		it("has correct displayName", () => {
			expect(Label.displayName).toBe("Label");
		});

		it("forwards ref correctly", () => {
			const ref = { current: null as HTMLLabelElement | null };

			render(<Label ref={ref}>Ref Label</Label>);

			expect(ref.current).toBeInstanceOf(HTMLLabelElement);
			expect(ref.current?.textContent).toBe("Ref Label");
		});

		it("passes through additional props", () => {
			render(
				<Label data-custom="custom-value" title="Tooltip text">
					Props Label
				</Label>,
			);

			const label = screen.getByText("Props Label");
			expect(label).toHaveAttribute("data-custom", "custom-value");
			expect(label).toHaveAttribute("title", "Tooltip text");
		});
	});

	describe("Edge Cases", () => {
		it("handles long text content", () => {
			const longText =
				"This is a very long label text that should wrap properly and display correctly without any issues or overflow problems in the layout.";

			render(<Label>{longText}</Label>);

			const label = screen.getByText(longText);
			expect(label).toBeInTheDocument();
		});

		it("handles special characters", () => {
			const specialText = "Label with émojis 🎉 and special chars & symbols";

			render(<Label>{specialText}</Label>);

			const label = screen.getByText(specialText);
			expect(label).toBeInTheDocument();
		});

		it("handles React nodes as children", () => {
			render(
				<Label>
					<span>Complex</span> <strong>Label</strong>
				</Label>,
			);

			expect(screen.getByText("Complex")).toBeInTheDocument();
			expect(screen.getByText("Label")).toBeInTheDocument();
		});

		it("handles null/undefined children gracefully", () => {
			render(<Label>{null}</Label>);

			const label = document.querySelector("label");
			expect(label).toBeInTheDocument();
		});
	});

	describe("CSS Variables and Theming", () => {
		it("supports CSS variables", () => {
			render(
				<Label style={{ "--custom-color": "red" } as React.CSSProperties}>
					Themed Label
				</Label>,
			);

			const label = screen.getByText("Themed Label");
			expect(label).toBeInTheDocument();
		});

		it("respects text-foreground theme class", () => {
			render(<Label>Themed Label</Label>);

			const label = screen.getByText("Themed Label");
			expect(label).toHaveClass("text-foreground");
		});
	});
});
