import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StatTile } from "./StatTile";

afterEach(cleanup);

it("shows label, value and caption as given", () => {
	render(<StatTile label="資産" value="¥100" caption="試算" />);
	expect(screen.getByText("資産")).toBeInTheDocument();
	expect(screen.getByText("¥100")).toBeInTheDocument();
	expect(screen.getByText("試算")).toBeInTheDocument();
});

it.each([
	["up", "上昇"],
	["down", "下降"],
	["flat", "横ばい"],
] as const)("announces the %s trend to screen readers", (trend, text) => {
	const { container } = render(
		<StatTile label="前月比" value="1" trend={trend} />,
	);
	expect(screen.getByText(text)).toBeInTheDocument();
	expect(container.querySelector("svg")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
});

it("renders the dash as is and no trend mark without a trend", () => {
	const { container } = render(<StatTile label="返済額" value="—" />);
	expect(screen.getByText("—")).toBeInTheDocument();
	expect(container.querySelector("svg")).toBeNull();
});
