import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ChoiceGroup } from "./ChoiceGroup";

afterEach(cleanup);

const options = ["朝型", "夜型", "どちらでもない"];

function Harness({ initial = "" }: { initial?: string }) {
	const [value, setValue] = useState(initial);
	return (
		<ChoiceGroup
			label="生活リズム"
			options={options}
			value={value}
			onChange={setValue}
		/>
	);
}

it("is a labelled radiogroup whose radios reflect the value", () => {
	render(<Harness initial="夜型" />);
	expect(
		screen.getByRole("radiogroup", { name: "生活リズム" }),
	).toBeInTheDocument();
	expect(screen.getAllByRole("radio")).toHaveLength(3);
	expect(screen.getByRole("radio", { name: "夜型" })).toBeChecked();
	expect(screen.getByRole("radio", { name: "朝型" })).not.toBeChecked();
});

it("reports the chosen option on click", () => {
	const onChange = vi.fn();
	render(
		<ChoiceGroup label="x" options={options} value="" onChange={onChange} />,
	);
	fireEvent.click(screen.getByRole("radio", { name: "夜型" }));
	expect(onChange).toHaveBeenCalledWith("夜型");
});

it("uses a roving tabindex and moves selection with arrow keys, wrapping around", async () => {
	const user = userEvent.setup();
	render(<Harness initial="朝型" />);
	expect(screen.getByRole("radio", { name: "朝型" })).toHaveAttribute(
		"tabindex",
		"0",
	);
	expect(screen.getByRole("radio", { name: "夜型" })).toHaveAttribute(
		"tabindex",
		"-1",
	);
	await user.tab();
	expect(screen.getByRole("radio", { name: "朝型" })).toHaveFocus();
	await user.keyboard("{ArrowRight}");
	expect(screen.getByRole("radio", { name: "夜型" })).toBeChecked();
	expect(screen.getByRole("radio", { name: "夜型" })).toHaveFocus();
	await user.keyboard("{ArrowLeft}{ArrowLeft}");
	expect(screen.getByRole("radio", { name: "どちらでもない" })).toBeChecked();
});

it("makes the first option tabbable when nothing is selected", () => {
	render(<Harness />);
	expect(screen.getByRole("radio", { name: "朝型" })).toHaveAttribute(
		"tabindex",
		"0",
	);
	for (const radio of screen.getAllByRole("radio"))
		expect(radio).not.toBeChecked();
});

it("renders the cards display with the same semantics", () => {
	const { container } = render(
		<ChoiceGroup
			label="Q1"
			options={options}
			value="朝型"
			onChange={() => {}}
			display="cards"
		/>,
	);
	expect(container.firstElementChild).toHaveAttribute("data-display", "cards");
	expect(screen.getByRole("radio", { name: "朝型" })).toBeChecked();
});

it("disables every option and ignores clicks and keys when disabled", async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	render(
		<ChoiceGroup
			label="x"
			options={options}
			value="朝型"
			onChange={onChange}
			disabled
		/>,
	);
	expect(screen.getByRole("radiogroup")).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	for (const radio of screen.getAllByRole("radio")) {
		expect(radio).toBeDisabled();
		expect(radio).toHaveAttribute("aria-disabled", "true");
	}
	await user.click(screen.getByRole("radio", { name: "夜型" }));
	await user.keyboard("{ArrowRight}");
	expect(onChange).not.toHaveBeenCalled();
});
