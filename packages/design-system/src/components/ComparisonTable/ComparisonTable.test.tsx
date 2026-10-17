import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ComparisonTable } from "./ComparisonTable";

afterEach(cleanup);

const props = {
	title: "プランの比較",
	columns: ["フリー", "プロ"],
	rows: [
		{ label: "月額", values: ["¥0", "¥4,800"] },
		{ label: "共有", values: [false, true] },
	],
};

it("renders headers, labels and text values as a table", () => {
	render(<ComparisonTable {...props} />);
	expect(screen.getByRole("table")).toBeInTheDocument();
	expect(
		screen.getByRole("columnheader", { name: "フリー" }),
	).toBeInTheDocument();
	expect(screen.getByRole("rowheader", { name: "月額" })).toBeInTheDocument();
	expect(screen.getByRole("cell", { name: "¥4,800" })).toBeInTheDocument();
});

it("reads booleans as あり / なし for screen readers", () => {
	render(<ComparisonTable {...props} />);
	const row = screen.getByRole("row", { name: /共有/ });
	const cells = within(row).getAllByRole("cell");
	expect(cells[0]).toHaveTextContent("なし");
	expect(cells[1]).toHaveTextContent("あり");
});

it("highlights only the chosen column", () => {
	render(<ComparisonTable {...props} highlightColumn={1} />);
	expect(screen.getByRole("columnheader", { name: "プロ" })).toHaveAttribute(
		"data-highlight",
		"true",
	);
	expect(screen.getByRole("columnheader", { name: "フリー" })).toHaveAttribute(
		"data-highlight",
		"false",
	);
});

it("exposes a focusable scroll region for narrow widths", () => {
	render(<ComparisonTable {...props} />);
	const region = screen.getByRole("region", { name: "プランの比較" });
	expect(region).toHaveAttribute("tabindex", "0");
});
