import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TextInput } from "./TextInput";

// Mock KeypadModal component
vi.mock("@/components/KeypadModal", () => ({
	KeypadModal: ({
		open,
		onClose,
		onSubmit,
		title,
		variant,
	}: {
		open: boolean;
		onClose: () => void;
		onSubmit: (val: string) => void;
		title?: string;
		variant?: string;
	}) => {
		if (!open) return null;
		return (
			<div role="dialog" aria-label="Keypad Modal">
				<h2>{title || "Keypad"}</h2>
				<div data-testid="variant">{variant || "numeric"}</div>
				<button type="button" onClick={onClose}>
					Close
				</button>
				<button type="button" onClick={() => onSubmit("123")}>
					Submit 123
				</button>
			</div>
		);
	},
}));

describe("TextInput", () => {
	const user = userEvent.setup();

	describe('type="text" (default)', () => {
		it("renders as a standard text input", () => {
			render(<TextInput placeholder="Enter text" />);
			const input = screen.getByPlaceholderText("Enter text");
			expect(input).toHaveAttribute("type", "text");
			expect(input).not.toHaveAttribute("readonly");
		});

		it("handles onChange events", async () => {
			const onChange = vi.fn();
			render(<TextInput onChange={onChange} />);
			const input = screen.getByRole("textbox");
			fireEvent.change(input, { target: { value: "Hello" } });
			expect(onChange).toHaveBeenCalledWith("Hello");
		});

		it("respects disabled state", () => {
			render(<TextInput disabled />);
			expect(screen.getByRole("textbox")).toBeDisabled();
		});
	});

	describe('type="numeric"', () => {
		it("renders as read-only and opens keypad on click", async () => {
			const onChange = vi.fn();
			render(
				<TextInput
					type="numeric"
					onChange={onChange}
					modalTitle="Enter Number"
				/>,
			);

			const input = screen.getByRole("textbox");
			expect(input).toHaveAttribute("readonly");

			await user.click(input);
			expect(screen.getByRole("dialog")).toBeInTheDocument();
			expect(screen.getByText("Enter Number")).toBeInTheDocument();
			expect(screen.getByTestId("variant")).toHaveTextContent("numeric");

			// Submit value
			await user.click(screen.getByText("Submit 123"));
			expect(onChange).toHaveBeenCalledWith("123");
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});

		it("closes modal without submitting", async () => {
			const onChange = vi.fn();
			render(<TextInput type="numeric" onChange={onChange} />);
			await user.click(screen.getByRole("textbox"));
			expect(screen.getByRole("dialog")).toBeInTheDocument();

			await user.click(screen.getByText("Close"));
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(onChange).not.toHaveBeenCalled();
		});
	});

	describe('type="time"', () => {
		it("renders as read-only and opens time keypad", async () => {
			render(<TextInput type="time" />);
			const input = screen.getByRole("textbox");
			await user.click(input);

			expect(screen.getByRole("dialog")).toBeInTheDocument();
			expect(screen.getByTestId("variant")).toHaveTextContent("time");
		});
	});

	describe('type="phone"', () => {
		it("renders as read-only and opens phone keypad", async () => {
			render(<TextInput type="phone" />);
			const input = screen.getByRole("textbox");
			await user.click(input);

			expect(screen.getByRole("dialog")).toBeInTheDocument();
			expect(screen.getByTestId("variant")).toHaveTextContent("phone");
		});
	});

	it("does not open modal when disabled", async () => {
		render(<TextInput type="numeric" disabled />);
		const input = screen.getByRole("textbox");
		await user.click(input);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
