import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Calculator } from "./Calculator";

// Mock react-i18next
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}));

describe("Calculator", () => {
	const user = userEvent.setup();

	it("renders correctly (inline mode)", () => {
		// If onResult is provided, it renders inline without modal
		render(<Calculator onResult={vi.fn()} />);
		// Check for display 0
		expect(
			screen.getByText("0", { selector: ".text-right" }),
		).toBeInTheDocument();
		// Check for buttons
		expect(screen.getByText("7")).toBeInTheDocument();
		expect(screen.getByText("=")).toBeInTheDocument();
		expect(screen.getByText("C")).toBeInTheDocument();
	});

	it("performs basic addition", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "2" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("3", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("performs basic subtraction", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "-" }));
		await user.click(screen.getByRole("button", { name: "3" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("2", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("performs multiplication with precedence", async () => {
		render(<Calculator onResult={vi.fn()} />);

		// 2 + 3 * 4 = 14
		await user.click(screen.getByRole("button", { name: "2" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "3" }));
		await user.click(screen.getByRole("button", { name: "*" }));
		await user.click(screen.getByRole("button", { name: "4" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("14", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("performs division", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "8" }));
		await user.click(screen.getByRole("button", { name: "/" }));
		await user.click(screen.getByRole("button", { name: "2" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("4", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("handles decimal numbers", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "." }));
		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "0" }));
		await user.click(screen.getByRole("button", { name: "." }));
		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("2", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("handles division by zero", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "/" }));
		await user.click(screen.getByRole("button", { name: "0" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("Error", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("clears display", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "C" }));

		expect(
			screen.getByText("0", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("opens modal when onResult is not provided", async () => {
		render(<Calculator />);

		const trigger = screen.getByRole("button", { name: "Calculator" });
		await user.click(trigger);

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(
			screen.getByText("0", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("calls onResult callback", async () => {
		const onResult = vi.fn();
		render(<Calculator onResult={onResult} />);

		await user.click(screen.getByRole("button", { name: "2" }));
		await user.click(screen.getByRole("button", { name: "*" }));
		await user.click(screen.getByRole("button", { name: "3" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(onResult).toHaveBeenCalledWith(6);
	});

	it("resets error state on new input", async () => {
		render(<Calculator onResult={vi.fn()} />);

		// Cause error
		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "/" }));
		await user.click(screen.getByRole("button", { name: "0" }));
		await user.click(screen.getByRole("button", { name: "=" }));
		expect(
			screen.getByText("Error", { selector: ".text-right" }),
		).toBeInTheDocument();

		// New input
		await user.click(screen.getByRole("button", { name: "5" }));
		expect(
			screen.getByText("5", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("handles invalid expressions", async () => {
		render(<Calculator onResult={vi.fn()} />);

		// "1 + =" (Trailing operator)
		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "=" }));
		expect(
			screen.getByText("Error", { selector: ".text-right" }),
		).toBeInTheDocument();

		// Clear
		await user.click(screen.getByRole("button", { name: "C" }));

		// "++" (Consecutive operators - may be valid if signed? No, our parser is simple infix)
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "=" }));
		expect(
			screen.getByText("Error", { selector: ".text-right" }),
		).toBeInTheDocument();

		// Clear
		await user.click(screen.getByRole("button", { name: "C" }));

		// "1 * -" (might crash parsing or be invalid)
		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "*" }));
		await user.click(screen.getByRole("button", { name: "-" }));
		await user.click(screen.getByRole("button", { name: "=" }));
		expect(
			screen.getByText("Error", { selector: ".text-right" }),
		).toBeInTheDocument();
	});
});
