import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./Switch";

// Mock Radix UI Switch component
vi.mock("@radix-ui/react-switch", async () => {
	const React = await import("react");
	return {
		Root: React.forwardRef(
			(
				{
					className,
					children,
					...props
				}: {
					className?: string;
					children?: React.ReactNode;
					[key: string]: unknown;
				},
				ref: React.Ref<HTMLButtonElement>,
			) => (
				<button
					ref={ref}
					data-testid="switch-root"
					className={className}
					// biome-ignore lint/suspicious/noExplicitAny: Spreading generic props
					{...(props as unknown as any)}
				>
					{children}
				</button>
			),
		),
		Thumb: ({
			className,
			...props
		}: React.ComponentPropsWithoutRef<"span">) => (
			<span data-testid="switch-thumb" className={className} {...props} />
		),
	};
});

// Mock the cn utility
vi.mock("@/utils/cn", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

describe("Switch Component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Basic Rendering", () => {
		it("renders correctly", () => {
			render(<Switch />);

			const switchRoot = screen.getByTestId("switch-root");
			expect(switchRoot).toBeInTheDocument();
			expect(switchRoot.tagName).toBe("BUTTON");

			const switchThumb = screen.getByTestId("switch-thumb");
			expect(switchThumb).toBeInTheDocument();
			expect(switchThumb.tagName).toBe("SPAN");
		});

		it("passes extra props to the root element", () => {
			render(<Switch id="test-switch" data-custom="value" />);

			const switchRoot = screen.getByTestId("switch-root");
			expect(switchRoot).toHaveAttribute("id", "test-switch");
			expect(switchRoot).toHaveAttribute("data-custom", "value");
		});

		it("forwards ref to the root element", () => {
			const ref = React.createRef<HTMLButtonElement>();
			render(<Switch ref={ref} />);

			expect(ref.current).toBeInstanceOf(HTMLButtonElement);
			expect(ref.current).toBe(screen.getByTestId("switch-root"));
		});
	});

	describe("Styling and Classes", () => {
		it("applies default classes to root", () => {
			render(<Switch />);

			const switchRoot = screen.getByTestId("switch-root");
			expect(switchRoot).toHaveClass(
				"peer",
				"inline-flex",
				"h-[var(--ui-switch-height)]",
				"w-[var(--ui-switch-width)]",
				"shrink-0",
				"cursor-pointer",
				"items-center",
				"rounded-full",
				"border-2",
				"border-transparent",
				"transition-colors",
				"focus-visible:outline-none",
				"focus-visible:ring-2",
				"focus-visible:ring-ring",
				"focus-visible:ring-offset-2",
				"focus-visible:ring-offset-background",
				"disabled:cursor-not-allowed",
				"disabled:opacity-50",
				"data-[state=checked]:bg-primary",
				"data-[state=unchecked]:bg-input",
			);
		});

		it("applies default classes to thumb", () => {
			render(<Switch />);

			const switchThumb = screen.getByTestId("switch-thumb");
			expect(switchThumb).toHaveClass(
				"pointer-events-none",
				"block",
				"h-[var(--ui-switch-thumb-size)]",
				"w-[var(--ui-switch-thumb-size)]",
				"rounded-full",
				"bg-background",
				"shadow-lg",
				"ring-0",
				"transition-transform",
				"data-[state=checked]:translate-x-[var(--ui-switch-thumb-translate)]",
				"data-[state=unchecked]:translate-x-0",
			);
		});

		it("merges custom className with default classes", () => {
			render(<Switch className="custom-switch-class" />);

			const switchRoot = screen.getByTestId("switch-root");
			expect(switchRoot).toHaveClass("custom-switch-class");
			expect(switchRoot).toHaveClass("peer"); // Should still have default classes
		});
	});

	describe("States", () => {
		it("handles checked state styling", () => {
			// We are mocking Radix, but passing data-state simulates what Radix does
			render(<Switch data-state="checked" />);

			const switchRoot = screen.getByTestId("switch-root");
			expect(switchRoot).toHaveAttribute("data-state", "checked");
			// The CSS classes rely on data-[state=checked] selector
		});

		it("handles unchecked state styling", () => {
			render(<Switch data-state="unchecked" />);

			const switchRoot = screen.getByTestId("switch-root");
			expect(switchRoot).toHaveAttribute("data-state", "unchecked");
		});

		it("handles disabled state", () => {
			render(<Switch disabled />);

			const switchRoot = screen.getByTestId("switch-root");
			expect(switchRoot).toBeDisabled();
			// Note: The `disabled:cursor-not-allowed` and `disabled:opacity-50` classes are checked in "Basic Rendering"
		});
	});
});
