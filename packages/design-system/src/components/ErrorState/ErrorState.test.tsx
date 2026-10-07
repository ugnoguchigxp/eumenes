import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorState } from "./ErrorState";

// Mock Lucide icons
vi.mock("lucide-react", () => ({
	AlertCircle: ({ className }: { className?: string }) => (
		<div data-testid="alert-circle" className={className}>
			AlertCircle
		</div>
	),
	RefreshCcw: ({ className }: { className?: string }) => (
		<div data-testid="refresh-ccw" className={className}>
			RefreshCcw
		</div>
	),
}));

// Mock Button component
vi.mock("../../../src/components/Button", () => ({
	Button: ({
		children,
		onClick,
		variant,
		className,
	}: {
		children?: React.ReactNode;
		onClick?: () => void;
		variant?: string;
		className?: string;
	}) => (
		<button
			type="button"
			data-variant={variant}
			className={className}
			onClick={onClick}
		>
			{children}
		</button>
	),
}));

describe("ErrorState Component", () => {
	const mockOnRetry = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Basic Rendering", () => {
		it("renders error state with default message", () => {
			render(<ErrorState error={new Error("Test error")} />);

			expect(screen.getByTestId("alert-circle")).toBeInTheDocument();
			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Test error")).toBeInTheDocument();
		});

		it("renders with unknown error", () => {
			render(<ErrorState error="Unknown error" />);

			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("renders with null error", () => {
			render(<ErrorState error={null} />);

			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("renders with undefined error", () => {
			render(<ErrorState error={undefined} />);

			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("renders without retry button when onRetry is not provided", () => {
			render(<ErrorState error={new Error("Test error")} />);

			expect(screen.queryByTestId("refresh-ccw")).not.toBeInTheDocument();
			expect(screen.queryByText("retry")).not.toBeInTheDocument();
		});

		it("renders with retry button when onRetry is provided", () => {
			render(
				<ErrorState error={new Error("Test error")} onRetry={mockOnRetry} />,
			);

			expect(screen.getByTestId("refresh-ccw")).toBeInTheDocument();
			expect(screen.getByText("再読み込み")).toBeInTheDocument();
			expect(screen.getByRole("button")).toBeInTheDocument();
		});
	});

	describe("Error Message Handling", () => {
		it("displays Error object message", () => {
			const error = new Error("Custom error message");
			render(<ErrorState error={error} />);

			expect(screen.getByText("Custom error message")).toBeInTheDocument();
		});

		it("displays string error message", () => {
			render(<ErrorState error="String error message" />);

			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("displays object error with message property", () => {
			const error = { message: "Object error message" };
			render(<ErrorState error={error} />);

			expect(screen.getByText("Object error message")).toBeInTheDocument();
		});

		it("handles error without message property", () => {
			const error = { someProperty: "value" };
			render(<ErrorState error={error} />);

			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("handles empty string error", () => {
			render(<ErrorState error="" />);

			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});
	});

	describe("Styling and Classes", () => {
		it("renders with proper structure", () => {
			render(<ErrorState error={new Error("Test")} />);

			const container = screen.getByText("Error").parentElement?.parentElement;
			expect(container).toBeTruthy();
			expect(container).toBeInTheDocument();
		});

		it("renders with custom className without error", () => {
			render(
				<ErrorState error={new Error("Test")} className="custom-error-class" />,
			);

			const container = screen.getByText("Error").parentElement?.parentElement;
			expect(container).toBeTruthy();
			expect(container).toBeInTheDocument();
		});

		it("applies icon container styles", () => {
			render(<ErrorState error={new Error("Test")} />);

			const iconContainer = screen.getByTestId("alert-circle").parentElement;
			expect(iconContainer).toHaveClass(
				"bg-destructive/10",
				"p-4",
				"rounded-full",
				"mb-4",
			);
		});

		it("applies title styles", () => {
			render(<ErrorState error={new Error("Test")} />);

			const title = screen.getByText("Error");
			expect(title).toHaveClass(
				"text-lg",
				"font-semibold",
				"text-foreground",
				"mb-2",
			);
			expect(title.tagName).toBe("H3");
		});

		it("applies message styles", () => {
			render(<ErrorState error={new Error("Test message")} />);

			const message = screen.getByText("Test message");
			expect(message).toHaveClass(
				"text-sm",
				"text-muted-foreground",
				"mb-6",
				"max-w-sm",
			);
		});

		it("applies icon styles", () => {
			render(<ErrorState error={new Error("Test")} />);

			const icon = screen.getByTestId("alert-circle");
			expect(icon).toHaveClass("h-8", "w-8", "text-destructive");
		});
	});

	describe("Retry Functionality", () => {
		it("calls onRetry when retry button is clicked", () => {
			render(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			const retryButton = screen.getByRole("button");
			fireEvent.click(retryButton);

			expect(mockOnRetry).toHaveBeenCalledTimes(1);
		});

		it("renders retry button with correct variant", () => {
			render(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			const retryButton = screen.getByRole("button");
			expect(retryButton).toHaveAttribute("data-variant", "outline");
		});

		it("renders retry button with gap styling", () => {
			render(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			const retryButton = screen.getByRole("button");
			expect(retryButton).toHaveClass("gap-2");
		});

		it("renders refresh icon in retry button", () => {
			render(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			expect(screen.getByTestId("refresh-ccw")).toBeInTheDocument();
			const refreshIcon = screen.getByTestId("refresh-ccw");
			expect(refreshIcon).toHaveClass("h-4", "w-4");
		});

		it("displays retry text with fallback", () => {
			render(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			expect(screen.getByText("再読み込み")).toBeInTheDocument();
			// The component shows the translation result
			const button = screen.getByRole("button");
			expect(button).toHaveTextContent("再読み込み");
		});
	});

	describe("Component Structure", () => {
		it("maintains proper DOM hierarchy", () => {
			render(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			const container = screen.getByText("Error").parentElement?.parentElement;
			expect(container).toBeInTheDocument();

			const iconContainer = screen.getByTestId("alert-circle").parentElement;
			const title = screen.getByText("Error");
			const message = screen.getByText("Test");
			const retryButton = screen.getByRole("button");

			expect(container).toContainElement(iconContainer);
			expect(container).toContainElement(title);
			expect(container).toContainElement(message);
			expect(container).toContainElement(retryButton);
		});

		it("renders all required elements", () => {
			render(
				<ErrorState error={new Error("Test error")} onRetry={mockOnRetry} />,
			);

			expect(screen.getByTestId("alert-circle")).toBeInTheDocument();
			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Test error")).toBeInTheDocument();
			expect(screen.getByTestId("refresh-ccw")).toBeInTheDocument();
			expect(screen.getByRole("button")).toBeInTheDocument();
		});
	});

	describe("Edge Cases", () => {
		it("handles empty error object", () => {
			render(<ErrorState error={{}} />);

			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("handles error with null message", () => {
			const error = { message: null };
			render(<ErrorState error={error} />);

			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("handles error with undefined message", () => {
			const error = { message: undefined };
			render(<ErrorState error={error} />);

			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("handles number error", () => {
			render(<ErrorState error={404} />);

			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("handles boolean error", () => {
			render(<ErrorState error={true} />);

			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});

		it("handles function error", () => {
			render(<ErrorState error={() => {}} />);

			expect(screen.getByText("Error")).toBeInTheDocument();
			expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		});
	});

	describe("Accessibility", () => {
		it("has proper heading structure", () => {
			render(<ErrorState error={new Error("Test")} />);

			const title = screen.getByRole("heading", { level: 3 });
			expect(title).toBeInTheDocument();
			expect(title).toHaveTextContent("Error");
		});

		it("has button with proper role when retry is provided", () => {
			render(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			// Button mock doesn't set type attribute by default
			expect(button.tagName).toBe("BUTTON");
		});
	});

	describe("Translation Function", () => {
		it("uses internal translation function", () => {
			// The component uses a simple translation function that returns the key
			render(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			// Should display the translation result
			expect(screen.getByText("再読み込み")).toBeInTheDocument();
			const button = screen.getByRole("button");
			expect(button).toHaveTextContent("再読み込み");
		});
	});

	describe("Component Behavior", () => {
		it("handles multiple renders with different errors", () => {
			const { rerender } = render(
				<ErrorState error={new Error("First error")} />,
			);

			expect(screen.getByText("First error")).toBeInTheDocument();

			rerender(<ErrorState error={new Error("Second error")} />);

			expect(screen.getByText("Second error")).toBeInTheDocument();
			expect(screen.queryByText("First error")).not.toBeInTheDocument();
		});

		it("handles adding and removing retry functionality", () => {
			const { rerender } = render(<ErrorState error={new Error("Test")} />);

			expect(screen.queryByRole("button")).not.toBeInTheDocument();

			rerender(<ErrorState error={new Error("Test")} onRetry={mockOnRetry} />);

			expect(screen.getByRole("button")).toBeInTheDocument();

			rerender(<ErrorState error={new Error("Test")} />);

			expect(screen.queryByRole("button")).not.toBeInTheDocument();
		});
	});

	describe("Error Message Extraction", () => {
		it("extracts message from standard Error object", () => {
			const error = new Error("Standard error");
			error.name = "CustomError";
			render(<ErrorState error={error} />);

			expect(screen.getByText("Standard error")).toBeInTheDocument();
			expect(screen.getByText("Error")).toBeInTheDocument();
		});

		it("handles custom error class", () => {
			class CustomError extends Error {
				constructor(message: string) {
					super(message);
					this.name = "CustomError";
				}
			}

			const error = new CustomError("Custom error message");
			render(<ErrorState error={error} />);

			expect(screen.getByText("Custom error message")).toBeInTheDocument();
		});

		it("handles error with stack but no message", () => {
			const error = new Error("test");
			// Modify message to undefined by redefining the property
			Object.defineProperty(error, "message", {
				value: undefined,
				writable: true,
				configurable: true,
			});
			render(<ErrorState error={error} />);

			// When message is undefined, it falls back to default message
			const messageElement = screen.getByText("Error").nextElementSibling;
			expect(messageElement).toBeInTheDocument();
			expect(messageElement).toHaveTextContent("Something went wrong.");
		});
	});

	describe("Export", () => {
		it("exports ErrorState component correctly", () => {
			expect(ErrorState).toBeDefined();
			expect(typeof ErrorState).toBe("function");
		});
	});
});
