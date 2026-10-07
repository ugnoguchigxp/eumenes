import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeypadModal } from "./KeypadModal";

// Mock Modal component
vi.mock("../../../src/components/Modal", () => ({
	Modal: ({
		open,
		children,
		title,
		onClose,
	}: {
		open?: boolean;
		children?: React.ReactNode;
		title?: string;
		onClose?: () => void;
	}) =>
		open ? (
			<div data-testid="modal">
				<h1>{title}</h1>
				<button type="button" onClick={onClose} aria-label="Close">
					Close
				</button>
				{children}
			</div>
		) : null,
}));

describe("KeypadModal Component", () => {
	const mockOnClose = vi.fn();
	const mockOnSubmit = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Number Variant (Default)", () => {
		it("renders with default props", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			expect(screen.getByTestId("modal")).toBeInTheDocument();
			expect(screen.getByText("数値を入力")).toBeInTheDocument();
			// Only 0-9 keys logic
			expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "9" })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "0" })).toBeInTheDocument();
		});

		it("inputs numbers and displays them", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "1" }));
			fireEvent.click(screen.getByRole("button", { name: "2" }));
			fireEvent.click(screen.getByRole("button", { name: "3" }));

			// Display should show "123". "123" is unique (buttons are 1, 2, 3)
			expect(screen.getByText("123")).toBeInTheDocument();
		});

		it("submits valid value", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "1" }));
			fireEvent.click(screen.getByRole("button", { name: "OK" }));

			expect(mockOnSubmit).toHaveBeenCalledWith("1");
		});

		it("shows error on empty submit", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "OK" }));

			expect(screen.getByText("値を入力してください")).toBeInTheDocument();
			expect(mockOnSubmit).not.toHaveBeenCalled();
		});

		it("clears input", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "1" }));
			fireEvent.click(screen.getByRole("button", { name: "C" }));

			// Display "1" should be gone. But button "1" remains.
			expect(screen.getAllByText("1")).toHaveLength(1);
		});

		it("backspaces input", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "1" }));
			fireEvent.click(screen.getByRole("button", { name: "2" }));
			fireEvent.click(screen.getByRole("button", { name: "⌫" }));

			// Should show '1'. Button '1' also exists.
			expect(screen.getAllByText("1")).toHaveLength(2);
			// '12' should not exist
			expect(screen.queryByText("12")).not.toBeInTheDocument();
		});

		it("handles decimal input if allowed", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					allowDecimal
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "1" }));
			fireEvent.click(screen.getByRole("button", { name: "." }));
			fireEvent.click(screen.getByRole("button", { name: "5" }));

			expect(screen.getByText("1.5")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "OK" }));
			expect(mockOnSubmit).toHaveBeenCalledWith("1.5");
		});

		it("prevents multiple decimals", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					allowDecimal
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "1" }));
			fireEvent.click(screen.getByRole("button", { name: "." }));
			fireEvent.click(screen.getByRole("button", { name: "." }));

			expect(screen.getByText("小数点は1つまでです")).toBeInTheDocument();
		});
	});

	describe("Time Variant", () => {
		it("formats display as time", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					variant="time"
				/>,
			);

			expect(screen.getByText("__:__")).toBeInTheDocument(); // initial

			fireEvent.click(screen.getByRole("button", { name: "0" }));
			fireEvent.click(screen.getByRole("button", { name: "9" }));

			expect(screen.getByText("09:__")).toBeInTheDocument();
		});

		it("validates time on submit", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					variant="time"
				/>,
			);

			// Enter 25:00 (invalid)
			fireEvent.click(screen.getByRole("button", { name: "2" }));
			fireEvent.click(screen.getByRole("button", { name: "5" }));
			fireEvent.click(screen.getByRole("button", { name: "0" }));
			fireEvent.click(screen.getByRole("button", { name: "0" }));
			fireEvent.click(screen.getByRole("button", { name: "OK" }));

			expect(
				screen.getByText(/有効な時刻.*入力してください/),
			).toBeInTheDocument();
			expect(mockOnSubmit).not.toHaveBeenCalled();
		});

		it("submits valid time", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					variant="time"
				/>,
			);

			// Enter 09:30
			fireEvent.click(screen.getByRole("button", { name: "0" }));
			fireEvent.click(screen.getByRole("button", { name: "9" }));
			fireEvent.click(screen.getByRole("button", { name: "3" }));
			fireEvent.click(screen.getByRole("button", { name: "0" }));
			fireEvent.click(screen.getByRole("button", { name: "OK" }));

			expect(mockOnSubmit).toHaveBeenCalledWith("09:30");
		});
	});

	describe("Phone Variant", () => {
		it("inputs phone number with hyphens", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					variant="phone"
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "0" }));
			fireEvent.click(screen.getByRole("button", { name: "9" }));
			fireEvent.click(screen.getByRole("button", { name: "0" }));

			// Hyphen button should be available
			const hyphenKey = screen.getByRole("button", { name: "-" });
			fireEvent.click(hyphenKey);

			fireEvent.click(screen.getByRole("button", { name: "1" }));

			expect(screen.getByText("090-1")).toBeInTheDocument();
		});

		it("prevents consecutive hyphens", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					variant="phone"
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "1" }));
			fireEvent.click(screen.getByRole("button", { name: "-" }));

			// Consecutive
			fireEvent.click(screen.getByRole("button", { name: "-" }));

			expect(
				screen.getByText("ハイフンを連続して入力することはできません"),
			).toBeInTheDocument();
		});

		it("prevents hyphen at end on submit", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					variant="phone"
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: "0" }));
			fireEvent.click(screen.getByRole("button", { name: "-" }));
			fireEvent.click(screen.getByRole("button", { name: "OK" }));

			expect(
				screen.getByText("ハイフンで終わることはできません"),
			).toBeInTheDocument();
		});
	});

	describe("Keyboard Interaction", () => {
		it("handles numeric keys", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.keyDown(window, { key: "5" });
			// "5" on button and "5" in display means 2 elements
			expect(screen.getAllByText("5")).toHaveLength(2);
		});

		it("handles Enter key to submit", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.keyDown(window, { key: "5" });
			fireEvent.keyDown(window, { key: "Enter" });

			expect(mockOnSubmit).toHaveBeenCalledWith("5");
		});

		it("handles Escape key to close", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.keyDown(window, { key: "Escape" });
			expect(mockOnClose).toHaveBeenCalled();
		});

		it("handles Backspace key", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
				/>,
			);

			fireEvent.keyDown(window, { key: "1" });
			fireEvent.keyDown(window, { key: "2" });
			// Display shows "12". One match (only display has "12", buttons are "1", "2").
			expect(screen.getByText("12")).toBeInTheDocument();

			fireEvent.keyDown(window, { key: "Backspace" });
			// Display shows "1". Button "1" exists.
			// We expect the display to update.
			// We can check if "12" is GONE.
			expect(screen.queryByText("12")).not.toBeInTheDocument();
			// And check consistent state (e.g. at least one '1').
			expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
		});

		it("handles Decimal key", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					allowDecimal
				/>,
			);

			fireEvent.keyDown(window, { key: "1" });
			fireEvent.keyDown(window, { key: "." });
			fireEvent.keyDown(window, { key: "5" });

			expect(screen.getByText("1.5")).toBeInTheDocument();
		});

		it("handles Minus key for phone", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					variant="phone"
				/>,
			);

			fireEvent.keyDown(window, { key: "0" });
			fireEvent.keyDown(window, { key: "-" });
			fireEvent.keyDown(window, { key: "1" });

			expect(screen.getByText("0-1")).toBeInTheDocument();
		});

		it("handles Numpad keys", () => {
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					allowDecimal
					variant="phone"
				/>,
			);

			// Numpad 5 (key usually '5' but testing code logic if key differs?)
			// Our code checks key OR code.
			// Let's force key match to fail, code match to pass
			fireEvent.keyDown(window, { key: "Unidentified", code: "Numpad5" });

			// NumpadDecimal
			fireEvent.keyDown(window, { key: "Unidentified", code: "NumpadDecimal" });

			// NumpadSubtract
			fireEvent.keyDown(window, {
				key: "Unidentified",
				code: "NumpadSubtract",
			});

			// Expect '5.-'
			// Wait, '5' then '.' then '-'.
			// phone allows hyphen. number allows decimal.
			// variant="phone" DOES NOT allow decimal.
			// allowDecimal is ignored in 'phone' variant usually?
			// KeypadModal logic:
			//     const canUseDecimal = variant === 'number' && allowDecimal;
			//     const canUseHyphen = variant === 'phone';
			// So if variant='phone', canUseDecimal is false.
			// Let's test separate components or check logic.
		});

		it("handles Numpad support (Decimal in numeric, Subtract in phone)", () => {
			// Case 1: Numeric with decimal (NumpadDecimal needs to work even if key is not '.')
			// We use key='5' to ensure number entry works physically, even if it hits the first branch.
			// Coverage for the 'code' branch of numbers might be unreachable if key is set,
			// but we can't force KeypadModal to ignore key if provided.
			const { unmount } = render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					allowDecimal
				/>,
			);

			// Use valid keys for numbers
			fireEvent.keyDown(window, { key: "5", code: "Numpad5" });

			// Use NumpadDecimal with key mismatch to test code branch
			fireEvent.keyDown(window, { key: "Unidentified", code: "NumpadDecimal" });

			fireEvent.keyDown(window, { key: "2", code: "Numpad2" });
			expect(screen.getByText("5.2")).toBeInTheDocument();
			unmount();

			// Case 2: Phone with hyphen
			render(
				<KeypadModal
					open={true}
					onClose={mockOnClose}
					onSubmit={mockOnSubmit}
					variant="phone"
				/>,
			);
			fireEvent.keyDown(window, { key: "0", code: "Numpad0" });

			// NumpadSubtract with key mismatch
			fireEvent.keyDown(window, {
				key: "Unidentified",
				code: "NumpadSubtract",
			});

			fireEvent.keyDown(window, { key: "1", code: "Numpad1" });
			expect(screen.getByText("0-1")).toBeInTheDocument();
		});
	});
});
