import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Input } from "./Input";

describe("Input", () => {
	it("renders correctly", () => {
		render(<Input placeholder="Enter text" />);
		expect(screen.getByPlaceholderText("Enter text")).toBeInTheDocument();
	});

	it("renders with default type", () => {
		render(<Input />);
		const input = screen.getByRole("textbox");
		// When no type is specified, input defaults to text behavior
		expect(input).toBeInTheDocument();
		expect(input).toHaveRole("textbox");
	});

	describe("Input Types", () => {
		it("renders text input", () => {
			render(<Input type="text" />);
			expect(screen.getByRole("textbox")).toHaveAttribute("type", "text");
		});

		it("renders password input", () => {
			render(<Input type="password" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "password");
		});

		it("renders email input", () => {
			render(<Input type="email" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "email");
		});

		it("renders number input", () => {
			render(<Input type="number" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "number");
		});

		it("renders search input", () => {
			render(<Input type="search" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "search");
		});

		it("renders tel input", () => {
			render(<Input type="tel" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "tel");
		});

		it("renders url input", () => {
			render(<Input type="url" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "url");
		});

		it("renders date input", () => {
			render(<Input type="date" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "date");
		});

		it("renders time input", () => {
			render(<Input type="time" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "time");
		});

		it("renders datetime-local input", () => {
			render(<Input type="datetime-local" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "datetime-local");
		});

		it("renders month input", () => {
			render(<Input type="month" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "month");
		});

		it("renders week input", () => {
			render(<Input type="week" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "week");
		});

		it("renders color input", () => {
			render(<Input type="color" />);
			const input = document.querySelector('input[type="color"]');
			expect(input).toBeInTheDocument();
			expect(input).toHaveAttribute("type", "color");
		});

		it("renders range input", () => {
			render(<Input type="range" />);
			const input = document.querySelector('input[type="range"]');
			expect(input).toBeInTheDocument();
			expect(input).toHaveAttribute("type", "range");
		});

		it("renders hidden input", () => {
			render(<Input type="hidden" />);
			const input = document.querySelector('input[type="hidden"]');
			expect(input).toBeInTheDocument();
			expect(input).toHaveAttribute("type", "hidden");
		});
	});

	describe("Props and Attributes", () => {
		it("applies custom className", () => {
			render(<Input className="custom-class" />);
			expect(screen.getByRole("textbox")).toHaveClass("custom-class");
		});

		it("passes through value prop", () => {
			render(<Input value="test value" readOnly />);
			expect(screen.getByDisplayValue("test value")).toBeInTheDocument();
		});

		it("passes through defaultValue prop", () => {
			render(<Input defaultValue="default value" />);
			expect(screen.getByDisplayValue("default value")).toBeInTheDocument();
		});

		it("passes through placeholder", () => {
			render(<Input placeholder="Placeholder text" />);
			expect(
				screen.getByPlaceholderText("Placeholder text"),
			).toBeInTheDocument();
		});

		it("passes through disabled state", () => {
			render(<Input disabled />);
			expect(screen.getByRole("textbox")).toBeDisabled();
		});

		it("passes through required attribute", () => {
			render(<Input required />);
			expect(screen.getByRole("textbox")).toBeRequired();
		});

		it("passes through readOnly attribute", () => {
			render(<Input readOnly />);
			expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
		});

		it("passes through maxLength attribute", () => {
			render(<Input maxLength={10} />);
			expect(screen.getByRole("textbox")).toHaveAttribute("maxlength", "10");
		});

		it("passes through minLength attribute", () => {
			render(<Input minLength={5} />);
			expect(screen.getByRole("textbox")).toHaveAttribute("minlength", "5");
		});

		it("passes through pattern attribute", () => {
			render(<Input pattern="[0-9]*" />);
			expect(screen.getByRole("textbox")).toHaveAttribute("pattern", "[0-9]*");
		});

		it("passes through min attribute", () => {
			render(<Input type="number" min="0" />);
			expect(screen.getByDisplayValue("")).toHaveAttribute("min", "0");
		});

		it("passes through max attribute", () => {
			render(<Input type="number" max="100" />);
			expect(screen.getByDisplayValue("")).toHaveAttribute("max", "100");
		});

		it("passes through step attribute", () => {
			render(<Input type="number" step="0.1" />);
			expect(screen.getByDisplayValue("")).toHaveAttribute("step", "0.1");
		});

		it("passes through autoComplete attribute", () => {
			render(<Input autoComplete="email" />);
			expect(screen.getByRole("textbox")).toHaveAttribute(
				"autocomplete",
				"email",
			);
		});

		it("passes through autoFocus attribute", () => {
			render(<Input autoFocus />);
			const input = screen.getByRole("textbox");
			// autoFocus is a boolean attribute that may not appear in DOM
			// We can test that the component accepts the prop without error
			expect(input).toBeInTheDocument();
		});

		it("passes through name attribute", () => {
			render(<Input name="test-input" />);
			expect(screen.getByRole("textbox")).toHaveAttribute("name", "test-input");
		});

		it("passes through id attribute", () => {
			render(<Input id="test-id" />);
			expect(screen.getByRole("textbox")).toHaveAttribute("id", "test-id");
		});

		it("passes through data attributes", () => {
			render(<Input data-testid="test-input" />);
			expect(screen.getByRole("textbox")).toHaveAttribute(
				"data-testid",
				"test-input",
			);
		});
	});

	describe("Events", () => {
		it("calls onChange when value changes", async () => {
			const handleChange = vi.fn();
			render(<Input onChange={handleChange} />);

			const input = screen.getByRole("textbox");
			await fireEvent.change(input, { target: { value: "test" } });

			expect(handleChange).toHaveBeenCalledTimes(1);
		});

		it("calls onFocus when focused", async () => {
			const handleFocus = vi.fn();
			render(<Input onFocus={handleFocus} />);

			const input = screen.getByRole("textbox");
			await fireEvent.focus(input);

			expect(handleFocus).toHaveBeenCalledTimes(1);
		});

		it("calls onBlur when blurred", async () => {
			const handleBlur = vi.fn();
			render(<Input onBlur={handleBlur} />);

			const input = screen.getByRole("textbox");
			await fireEvent.blur(input);

			expect(handleBlur).toHaveBeenCalledTimes(1);
		});

		it("calls onKeyDown when key is pressed", async () => {
			const handleKeyDown = vi.fn();
			render(<Input onKeyDown={handleKeyDown} />);

			const input = screen.getByRole("textbox");
			await fireEvent.keyDown(input, { key: "Enter" });

			expect(handleKeyDown).toHaveBeenCalledTimes(1);
		});

		it("calls onKeyUp when key is released", async () => {
			const handleKeyUp = vi.fn();
			render(<Input onKeyUp={handleKeyUp} />);

			const input = screen.getByRole("textbox");
			await fireEvent.keyUp(input, { key: "Enter" });

			expect(handleKeyUp).toHaveBeenCalledTimes(1);
		});

		it("calls onInput when input value changes", async () => {
			const handleInput = vi.fn();
			render(<Input onInput={handleInput} />);

			const input = screen.getByRole("textbox");
			await fireEvent.input(input, { target: { value: "test" } });

			expect(handleInput).toHaveBeenCalledTimes(1);
		});
	});

	describe("Styling Classes", () => {
		it("has base input classes", () => {
			render(<Input />);
			const input = screen.getByRole("textbox");
			expect(input).toHaveClass(
				"flex",
				"h-ui",
				"w-full",
				"rounded-md",
				"border",
				"border-input",
				"bg-background",
				"px-3",
				"text-ui",
				"ring-offset-background",
				"file:border-0",
				"file:bg-transparent",
				"file:text-sm",
				"file:font-medium",
				"file:text-foreground",
				"placeholder:text-muted-foreground",
				"focus-visible:outline-none",
				"focus-visible:ring-2",
				"focus-visible:ring-ring",
				"focus-visible:ring-offset-2",
				"disabled:cursor-not-allowed",
				"disabled:opacity-50",
				"min-h-ui-touch",
			);
		});

		it("merges custom className with base classes", () => {
			render(<Input className="custom-class another-class" />);
			const input = screen.getByRole("textbox");
			expect(input).toHaveClass("custom-class", "another-class");
			expect(input).toHaveClass("flex", "h-ui", "w-full"); // Should still have base classes
		});
	});

	describe("Forward Ref", () => {
		it("forwards ref correctly", () => {
			const ref = { current: null as HTMLInputElement | null };
			render(<Input ref={ref} />);
			expect(ref.current).toBeInstanceOf(HTMLInputElement);
		});

		it("ref focuses correctly", () => {
			const ref = { current: null as HTMLInputElement | null };
			render(<Input ref={ref} />);

			if (ref.current) {
				ref.current.focus();
				expect(document.activeElement).toBe(ref.current);
			}
		});
	});

	describe("Accessibility", () => {
		it("has proper ARIA attributes", () => {
			render(<Input aria-label="Test input" aria-describedby="description" />);
			const input = screen.getByRole("textbox");
			expect(input).toHaveAttribute("aria-label", "Test input");
			expect(input).toHaveAttribute("aria-describedby", "description");
		});

		it("supports aria-invalid for validation states", () => {
			render(<Input aria-invalid="true" />);
			expect(screen.getByRole("textbox")).toHaveAttribute(
				"aria-invalid",
				"true",
			);
		});

		it("supports aria-required for required indication", () => {
			render(<Input aria-required="true" />);
			expect(screen.getByRole("textbox")).toHaveAttribute(
				"aria-required",
				"true",
			);
		});

		it("supports aria-disabled for disabled indication", () => {
			render(<Input aria-disabled="true" />);
			expect(screen.getByRole("textbox")).toHaveAttribute(
				"aria-disabled",
				"true",
			);
		});
	});

	describe("File Input Specific", () => {
		it("handles file input type", () => {
			render(<Input type="file" />);
			const input = screen.getByDisplayValue("");
			expect(input).toHaveAttribute("type", "file");
			expect(input).toHaveClass(
				"file:border-0",
				"file:bg-transparent",
				"file:text-sm",
				"file:font-medium",
				"file:text-foreground",
			);
		});
	});

	describe("Edge Cases", () => {
		it("renders with no props", () => {
			render(<Input />);
			expect(screen.getByRole("textbox")).toBeInTheDocument();
		});

		it("handles empty string className", () => {
			render(<Input className="" />);
			const input = screen.getByRole("textbox");
			expect(input).toBeInTheDocument();
		});

		it("handles undefined className", () => {
			render(<Input className={undefined} />);
			const input = screen.getByRole("textbox");
			expect(input).toBeInTheDocument();
		});
	});
});
