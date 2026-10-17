import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RangeSlider } from "./RangeSlider";

afterEach(cleanup);

it("exposes a labelled range input with its bounds and value text", () => {
	render(
		<RangeSlider
			label="積立額"
			value={3000}
			min={0}
			max={10000}
			step={1000}
			onChange={() => {}}
			formatValue={(n) => `¥${n.toLocaleString("ja-JP")}`}
		/>,
	);
	const slider = screen.getByRole("slider", { name: "積立額" });
	expect(slider).toHaveAttribute("min", "0");
	expect(slider).toHaveAttribute("max", "10000");
	expect(slider).toHaveAttribute("step", "1000");
	expect(slider).toHaveValue("3000");
	expect(slider).toHaveAttribute("aria-valuetext", "¥3,000");
	expect(screen.getByText("¥3,000")).toBeInTheDocument();
});

it("shows the raw number without formatValue", () => {
	render(
		<RangeSlider label="年齢" value={40} min={20} max={70} onChange={() => {}} />,
	);
	expect(screen.getByText("40")).toBeInTheDocument();
});

it("reports a number through onChange", () => {
	const onChange = vi.fn();
	render(
		<RangeSlider label="年齢" value={40} min={20} max={70} onChange={onChange} />,
	);
	fireEvent.change(screen.getByRole("slider"), { target: { value: "55" } });
	expect(onChange).toHaveBeenCalledWith(55);
});

it("can be disabled", () => {
	render(
		<RangeSlider
			label="年齢"
			value={40}
			min={20}
			max={70}
			onChange={() => {}}
			disabled
		/>,
	);
	expect(screen.getByRole("slider")).toBeDisabled();
});
