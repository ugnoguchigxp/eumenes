import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopyClipButton } from "./CopyClipButton";

// Mock navigator.clipboard
const mockWriteText = vi.fn();
Object.defineProperty(navigator, "clipboard", {
	value: {
		writeText: mockWriteText,
	},
	writable: true,
});

describe("CopyClipButton Component", () => {
	beforeEach(() => {
		mockWriteText.mockClear();
		mockWriteText.mockResolvedValue(undefined);
	});

	describe("Basic Rendering", () => {
		it("renders button with text", () => {
			render(<CopyClipButton text="Copy me" />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			expect(button).toHaveTextContent("Copy me");
		});

		it("renders copy icon", () => {
			render(<CopyClipButton text="Copy me" />);

			const icon = document.querySelector(".h-3.w-3");
			expect(icon).toBeInTheDocument();
		});

		it("applies custom className", () => {
			render(<CopyClipButton text="Copy me" className="custom-class" />);

			const button = screen.getByRole("button");
			expect(button).toHaveClass("custom-class");
		});

		it("has proper accessibility attributes", () => {
			render(<CopyClipButton text="Copy me" />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("title", "click_to_copy");
		});
	});

	describe("Copy Functionality", () => {
		it("copies text to clipboard when clicked", async () => {
			const onCopied = vi.fn();
			render(<CopyClipButton text="Test text" onCopied={onCopied} />);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(mockWriteText).toHaveBeenCalledWith("Test text");
			expect(onCopied).toHaveBeenCalledWith("Test text");
		});

		it("copies copyValue instead of text when provided", async () => {
			const onCopied = vi.fn();
			render(
				<CopyClipButton
					text="Display text"
					copyValue="Actual copy value"
					onCopied={onCopied}
				/>,
			);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(mockWriteText).toHaveBeenCalledWith("Actual copy value");
			expect(onCopied).toHaveBeenCalledWith("Actual copy value");
		});

		it("handles clipboard errors", async () => {
			const onCopyError = vi.fn();
			const error = new Error("Clipboard denied");
			mockWriteText.mockRejectedValue(error);

			render(<CopyClipButton text="Test text" onCopyError={onCopyError} />);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(onCopyError).toHaveBeenCalledWith(error);
		});

		it("stops event propagation", () => {
			const onCopied = vi.fn();
			const mockStopPropagation = vi.fn();

			render(<CopyClipButton text="Test text" onCopied={onCopied} />);

			const button = screen.getByRole("button");
			const clickEvent = new MouseEvent("click", { bubbles: true });
			Object.defineProperty(clickEvent, "stopPropagation", {
				value: mockStopPropagation,
			});

			fireEvent(button, clickEvent);

			expect(mockStopPropagation).toHaveBeenCalled();
		});
	});

	describe("Button Styling", () => {
		it("uses link variant", () => {
			render(<CopyClipButton text="Copy me" />);

			const button = screen.getByRole("button");
			expect(button).toHaveClass("underline");
		});

		it("has default styling classes", () => {
			render(<CopyClipButton text="Copy me" />);

			const button = screen.getByRole("button");
			expect(button).toHaveClass(
				"p-0",
				"h-auto",
				"font-normal",
				"hover:no-underline",
				"hover:text-primary",
				"items-center",
				"gap-1",
			);
		});

		it("merges custom className with defaults", () => {
			render(<CopyClipButton text="Copy me" className="custom-class" />);

			const button = screen.getByRole("button");
			expect(button).toHaveClass("custom-class");
			expect(button).toHaveClass("p-0", "h-auto"); // Should still have default classes
		});
	});

	describe("Edge Cases", () => {
		it("handles empty text", async () => {
			const onCopied = vi.fn();
			render(<CopyClipButton text="" onCopied={onCopied} />);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(mockWriteText).toHaveBeenCalledWith("");
			expect(onCopied).toHaveBeenCalledWith("");
		});

		it("handles whitespace text", async () => {
			const onCopied = vi.fn();
			render(<CopyClipButton text="   " onCopied={onCopied} />);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(mockWriteText).toHaveBeenCalledWith("   ");
			expect(onCopied).toHaveBeenCalledWith("   ");
		});

		it("handles special characters", async () => {
			const onCopied = vi.fn();
			const specialText = "Special chars: !@#$%^&*()";
			render(<CopyClipButton text={specialText} onCopied={onCopied} />);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(mockWriteText).toHaveBeenCalledWith(specialText);
			expect(onCopied).toHaveBeenCalledWith(specialText);
		});

		it("handles long text", async () => {
			const onCopied = vi.fn();
			const longText = "A".repeat(1000);
			render(<CopyClipButton text={longText} onCopied={onCopied} />);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(mockWriteText).toHaveBeenCalledWith(longText);
			expect(onCopied).toHaveBeenCalledWith(longText);
		});
	});

	describe("Callback Behavior", () => {
		it("does not call onCopied when not provided", async () => {
			render(<CopyClipButton text="Test text" />);

			const button = screen.getByRole("button");
			fireEvent.click(button);

			expect(mockWriteText).toHaveBeenCalledWith("Test text");
			// No error should be thrown
		});

		it("does not call onCopyError when not provided", async () => {
			mockWriteText.mockRejectedValue(new Error("Test error"));

			render(<CopyClipButton text="Test text" />);

			const button = screen.getByRole("button");

			// Should not throw error
			expect(() => fireEvent.click(button)).not.toThrow();
		});

		it("calls onCopied with correct value when copyValue is provided", async () => {
			const onCopied = vi.fn();
			render(
				<CopyClipButton
					text="Display"
					copyValue="Copy value"
					onCopied={onCopied}
				/>,
			);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(onCopied).toHaveBeenCalledTimes(1);
			expect(onCopied).toHaveBeenCalledWith("Copy value");
		});

		it("calls onCopyError with error object", async () => {
			const onCopyError = vi.fn();
			const error = new Error("Permission denied");
			mockWriteText.mockRejectedValue(error);

			render(<CopyClipButton text="Test text" onCopyError={onCopyError} />);

			const button = screen.getByRole("button");
			await fireEvent.click(button);

			expect(onCopyError).toHaveBeenCalledTimes(1);
			expect(onCopyError).toHaveBeenCalledWith(error);
		});
	});

	describe("Component Structure", () => {
		it("renders as button element", () => {
			render(<CopyClipButton text="Copy me" />);

			const button = screen.getByRole("button");
			expect(button.tagName).toBe("BUTTON");
		});

		it("contains both text and icon", () => {
			render(<CopyClipButton text="Copy me" />);

			const button = screen.getByRole("button");
			expect(button).toHaveTextContent("Copy me");

			const icon = button.querySelector(".h-3.w-3");
			expect(icon).toBeInTheDocument();
		});

		it("preserves additional props", () => {
			render(<CopyClipButton text="Copy me" />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			expect(button).toHaveAttribute("title", "click_to_copy");
		});
	});

	describe("Icon Rendering", () => {
		it("renders copy icon with correct classes", () => {
			render(<CopyClipButton text="Copy me" />);

			const icon = document.querySelector(".h-3.w-3");
			expect(icon).toBeInTheDocument();
			expect(icon).toHaveClass("opacity-50");
		});

		it("icon is present even with empty text", () => {
			render(<CopyClipButton text="" />);

			const icon = document.querySelector(".h-3.w-3");
			expect(icon).toBeInTheDocument();
		});
	});
});
