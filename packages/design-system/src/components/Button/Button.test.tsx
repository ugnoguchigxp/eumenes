import { fireEvent, render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
	it("renders correctly", () => {
		render(<Button>Click me</Button>);
		expect(
			screen.getByRole("button", { name: /click me/i }),
		).toBeInTheDocument();
	});

	describe("Variants", () => {
		const variants = [
			["default", "bg-primary"],
			["destructive", "bg-destructive"],
			["outline", "border-input"],
			["secondary", "bg-secondary"],
			["ghost", "hover:bg-accent"],
			["link", "underline"],
			["success", "bg-success"],
			["warning", "bg-warning"],
			["info", "bg-info"],
			["outline-success", "border-success"],
			["outline-warning", "border-warning"],
			["outline-destructive", "border-destructive"],
			["fab", "rounded-full"],
			["circle-help", "rounded-full"],
			["circle-alert", "rounded-full"],
			["option", "border-input"],
			["option-active", "bg-primary/10"],
		] as const;

		it.each(
			variants,
		)("renders %s variant with correct class", (variant, expectedClass) => {
			render(<Button variant={variant}>Button</Button>);
			const button = screen.getByRole("button");
			expect(button).toHaveClass(expectedClass);
		});

		it("renders success variant via success prop", () => {
			render(<Button success>Success</Button>);
			const button = screen.getByRole("button");
			expect(button).toHaveClass("bg-success");
			expect(button.querySelector(".lucide-check")).toBeInTheDocument();
		});

		it("renders error variant via error prop", () => {
			render(<Button error>Error</Button>);
			const button = screen.getByRole("button");
			expect(button).toHaveClass("bg-destructive");
			expect(button.querySelector(".lucide-x")).toBeInTheDocument();
		});
	});

	describe("Sizes", () => {
		const sizes = [
			["default", "h-ui"],
			["sm", "h-8"],
			["lg", "h-10"],
			["icon", "w-[var(--ui-component-height)]"],
			["circle", "h-8 w-8 rounded-full"],
		] as const;

		it.each(
			sizes,
		)("renders %s size with correct class", (size, expectedClass) => {
			render(<Button size={size}>Button</Button>);
			const button = screen.getByRole("button");
			expect(button).toHaveClass(expectedClass);
		});
	});

	describe("States", () => {
		it("renders loading state", () => {
			render(<Button loading>Loading</Button>);
			const button = screen.getByRole("button");
			expect(button).toBeDisabled();
			expect(button.querySelector(".animate-spin")).toBeInTheDocument();
			// Content should not be visible when loading (implementation detail check)
			expect(screen.queryByText("Loading")).not.toBeInTheDocument();
		});

		it("renders disabled state", () => {
			render(<Button disabled>Disabled</Button>);
			const button = screen.getByRole("button");
			expect(button).toBeDisabled();
		});

		it("truncates long labels", () => {
			const longText =
				"This is a very long button label that should be truncated";
			render(<Button maxLabelLength={10}>{longText}</Button>);
			// Implementation slices string and adds ellipsis
			const expected = "This is a…";
			expect(screen.getByText(expected)).toBeInTheDocument();
			// Hover title should contain full text
			expect(screen.getByTitle(longText)).toBeInTheDocument();
		});

		it("does not truncate short labels", () => {
			const shortText = "Short";
			render(<Button maxLabelLength={10}>{shortText}</Button>);
			expect(screen.getByText("Short")).toBeInTheDocument();
			// Implementation detail: undefined title is not in the document
			// queryByTitle would return null, using querySelector to be equivalent to "title attribute missing" check if needed,
			// but checking if title element exists is hard since title is an attribute.
			// We can check the wrapper span doesn't have title.
			const textElement = screen.getByText("Short");
			// The text is inside a span. That span might have the title.
			// Layout: span.flex > span(label) > text
			// or span.flex > text (if not string?) No, code wraps string in span lines 108-115.
			const labelSpan = textElement.closest("span[title]");
			expect(labelSpan).not.toBeInTheDocument();
		});

		it("handles non-string children without truncation", () => {
			render(
				<Button maxLabelLength={5}>
					<span>Complex Child</span>
				</Button>,
			);
			expect(screen.getByText("Complex Child")).toBeInTheDocument();
		});
	});

	describe("Polymorphism", () => {
		it("renders as a child (Slot) when asChild is true", () => {
			render(
				<Button asChild>
					<a href="/link">Link Button</a>
				</Button>,
			);
			const link = screen.getByRole("link", { name: /link button/i });
			expect(link).toHaveAttribute("href", "/link");

			// When asChild is true, the Button styles are applied to the internal wrapper span,
			// not the user-provided child, due to the component structure.
			// Verification: Check that the link is contained within an element having button classes.
			const buttonWrapper = link.closest(".inline-flex");
			expect(buttonWrapper).toBeInTheDocument();
			expect(buttonWrapper).toHaveClass("bg-primary");
		});
	});

	describe("Interactions", () => {
		it("calls onClick when clicked", async () => {
			const handleClick = vi.fn();
			render(<Button onClick={handleClick}>Click Me</Button>);
			await fireEvent.click(screen.getByRole("button"));
			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it("does not call onClick when disabled", async () => {
			const handleClick = vi.fn();
			render(
				<Button disabled onClick={handleClick}>
					Click Me
				</Button>,
			);
			await fireEvent.click(screen.getByRole("button"));
			expect(handleClick).not.toHaveBeenCalled();
		});

		it("does not call onClick when loading", async () => {
			const handleClick = vi.fn();
			render(
				<Button loading onClick={handleClick}>
					Click Me
				</Button>,
			);
			await fireEvent.click(screen.getByRole("button"));
			expect(handleClick).not.toHaveBeenCalled();
		});
	});

	describe("Props", () => {
		it("renders with icon", () => {
			render(<Button icon={Bell}>With Icon</Button>);
			// Check for SVG
			expect(
				screen.getByRole("button").querySelector("svg"),
			).toBeInTheDocument();
			expect(screen.getByText("With Icon")).toBeInTheDocument();
		});

		it("renders icon only when no children", () => {
			render(<Button icon={Bell} />);
			expect(
				screen.getByRole("button").querySelector("svg"),
			).toBeInTheDocument();
			// Icon should not have margin-right when no children
			expect(screen.getByRole("button").querySelector("svg")).toHaveClass(
				"mr-0",
			);
		});

		it("merges custom className", () => {
			render(<Button className="custom-class">Custom</Button>);
			expect(screen.getByRole("button")).toHaveClass("custom-class");
		});
	});
});
