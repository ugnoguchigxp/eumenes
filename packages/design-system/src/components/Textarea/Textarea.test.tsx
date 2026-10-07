import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Textarea } from "./Textarea";

describe("Textarea", () => {
	const user = userEvent.setup();

	it("renders correctly", () => {
		render(<Textarea placeholder="Type here" />);
		expect(screen.getByPlaceholderText("Type here")).toBeInTheDocument();
		expect(screen.getByRole("textbox")).toHaveClass("min-h-[80px]");
	});

	it("handles input changes", async () => {
		const onChange = vi.fn();
		render(<Textarea onChange={onChange} />);

		await user.type(screen.getByRole("textbox"), "Hello world");
		expect(onChange).toHaveBeenCalled();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"Hello world",
		);
	});

	it("respects disabled state", () => {
		render(<Textarea disabled />);
		expect(screen.getByRole("textbox")).toBeDisabled();
	});
});
